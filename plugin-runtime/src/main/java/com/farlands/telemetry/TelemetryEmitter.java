package com.farlands.telemetry;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/**
 * Non-blocking, bounded telemetry delivery. Events live only in this queue; the
 * control plane closes them into aggregate windows and never persists raw rows.
 */
public final class TelemetryEmitter implements AutoCloseable {
    private static final int QUEUE_CAPACITY = 5_000;
    private static final int BATCH_SIZE = 1_000;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);

    public record WorldEvent(
        String kind,
        Instant timestamp,
        String playerName,
        String region,
        String subject,
        double value
    ) {}

    private final ArrayBlockingQueue<WorldEvent> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final Object bufferLock = new Object();
    private final AtomicBoolean requestInFlight = new AtomicBoolean(false);
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicLong dropped = new AtomicLong();
    /** Failed delivery stays ahead of newer queued windows. Guarded by bufferLock. */
    private List<WorldEvent> retryBatch = List.of();
    /** Queue, retry, and in-flight events share one hard memory budget. Guarded by bufferLock. */
    private int buffered;
    private final HttpClient client;
    private final URI endpoint;
    private final String internalKey;
    private final Logger logger;
    private final ScheduledExecutorService scheduler;

    private TelemetryEmitter(URI endpoint, String internalKey, Logger logger) {
        this.endpoint = endpoint;
        this.internalKey = internalKey;
        this.logger = logger;
        this.client = HttpClient.newBuilder()
            .connectTimeout(REQUEST_TIMEOUT)
            .build();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "farlands-telemetry");
            thread.setDaemon(true);
            return thread;
        });
        this.scheduler.scheduleWithFixedDelay(this::flushSafely, 5, 5, TimeUnit.SECONDS);
    }

    public static Optional<TelemetryEmitter> fromEnvironment(Logger logger) {
        String serverId = environment("FARLANDS_SERVER_ID");
        String baseUrl = environment("FARLANDS_TELEMETRY_URL");
        String internalKey = environment("INTERNAL_API_KEY");
        if (serverId == null || baseUrl == null || internalKey == null) {
            logger.info(
                "Aggregate telemetry disabled: FARLANDS_SERVER_ID, FARLANDS_TELEMETRY_URL, and INTERNAL_API_KEY are required"
            );
            return Optional.empty();
        }

        try {
            String endpoint = baseUrl.replaceAll("/+$", "")
                + "/internal/telemetry/"
                + URLEncoder.encode(serverId, StandardCharsets.UTF_8);
            return Optional.of(new TelemetryEmitter(URI.create(endpoint), internalKey, logger));
        } catch (IllegalArgumentException error) {
            logger.warning("Aggregate telemetry disabled: endpoint configuration is invalid");
            return Optional.empty();
        }
    }

    private static String environment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) return null;
        return value.trim();
    }

    public void emit(WorldEvent event) {
        synchronized (bufferLock) {
            if (closed.get()) return;
            if (buffered >= QUEUE_CAPACITY || !queue.offer(event)) {
                dropped.incrementAndGet();
                return;
            }
            buffered++;
        }
    }

    private void flushSafely() {
        try {
            flush();
        } catch (RuntimeException error) {
            logger.warning("Aggregate telemetry flush failed before delivery");
        }
    }

    private void flush() {
        if (closed.get() || !requestInFlight.compareAndSet(false, true)) return;
        // Close can win between the first check and the CAS. Do not drain a
        // queue after shutdown has taken ownership of the final bounded flush.
        if (closed.get()) {
            requestInFlight.set(false);
            return;
        }
        List<WorldEvent> batch = nextBatch();
        if (batch.isEmpty()) {
            requestInFlight.set(false);
            reportDrops();
            return;
        }

        HttpRequest request = requestFor(batch);

        client.sendAsync(request, HttpResponse.BodyHandlers.discarding())
            .whenComplete((response, error) -> {
                boolean accepted = error == null && response != null
                    && response.statusCode() >= 200 && response.statusCode() < 300;
                completeBatch(batch, accepted);
                requestInFlight.set(false);
                reportDrops();
            });
    }

    private HttpRequest requestFor(List<WorldEvent> batch) {
        StringBuilder body = new StringBuilder();
        for (WorldEvent event : batch) {
            if (!body.isEmpty()) body.append('\n');
            body.append(toJson(event));
        }
        return HttpRequest.newBuilder(endpoint)
            .timeout(REQUEST_TIMEOUT)
            .header("content-type", "application/x-ndjson")
            .header("x-internal-key", internalKey)
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build();
    }

    private List<WorldEvent> nextBatch() {
        synchronized (bufferLock) {
            if (!retryBatch.isEmpty()) {
                List<WorldEvent> batch = retryBatch;
                retryBatch = List.of();
                return batch;
            }
            List<WorldEvent> batch = new ArrayList<>(BATCH_SIZE);
            queue.drainTo(batch, BATCH_SIZE);
            return batch;
        }
    }

    private void completeBatch(List<WorldEvent> batch, boolean accepted) {
        synchronized (bufferLock) {
            if (accepted) {
                buffered -= batch.size();
                return;
            }
            if (closed.get()) {
                buffered -= batch.size();
                dropped.addAndGet(batch.size());
                return;
            }
            // This batch is older than everything still in queue. Keeping it
            // separate makes the next attempt preserve event-time order.
            retryBatch = List.copyOf(batch);
        }
    }

    private void discardWaiting() {
        synchronized (bufferLock) {
            int waiting = queue.size() + retryBatch.size();
            queue.clear();
            retryBatch = List.of();
            buffered -= waiting;
            if (waiting > 0) dropped.addAndGet(waiting);
        }
    }

    private void reportDrops() {
        long count = dropped.getAndSet(0);
        if (count > 0) logger.warning("Aggregate telemetry queue dropped " + count + " event(s)");
    }

    private static String toJson(WorldEvent event) {
        return "{"
            + "\"kind\":" + quote(event.kind()) + ","
            + "\"ts\":" + quote(event.timestamp().toString()) + ","
            + "\"player_name\":" + nullable(event.playerName()) + ","
            + "\"region\":" + nullable(event.region()) + ","
            + "\"subject\":" + nullable(event.subject()) + ","
            + "\"value\":" + event.value()
            + "}";
    }

    private static String nullable(String value) {
        return value == null ? "null" : quote(value);
    }

    private static String quote(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> escaped.append("\\\"");
                case '\\' -> escaped.append("\\\\");
                case '\b' -> escaped.append("\\b");
                case '\f' -> escaped.append("\\f");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) escaped.append(String.format("\\u%04x", (int) character));
                    else escaped.append(character);
                }
            }
        }
        return escaped.append('"').toString();
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        scheduler.shutdownNow();

        if (requestInFlight.get()) {
            // The HTTP callback owns the in-flight batch and will account for
            // it. Everything waiting behind it is bounded and dropped now.
            discardWaiting();
            reportDrops();
            return;
        }

        List<WorldEvent> finalBatch = nextBatch();
        boolean accepted = false;
        if (!finalBatch.isEmpty()) {
            try {
                HttpResponse<Void> response = client.send(
                    requestFor(finalBatch),
                    HttpResponse.BodyHandlers.discarding()
                );
                accepted = response.statusCode() >= 200 && response.statusCode() < 300;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } catch (Exception error) {
                // Accounted below without logging credentials or payloads.
            }
        }
        completeBatch(finalBatch, accepted);
        discardWaiting();
        reportDrops();
    }
}
