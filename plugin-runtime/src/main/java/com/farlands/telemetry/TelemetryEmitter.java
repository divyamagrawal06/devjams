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
import java.util.UUID;
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

    private record Batch(long sequence, List<WorldEvent> events) {}

    private final ArrayBlockingQueue<WorldEvent> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final Object bufferLock = new Object();
    private final AtomicBoolean requestInFlight = new AtomicBoolean(false);
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicLong dropped = new AtomicLong();
    /** Failed delivery stays ahead of newer queued windows. Guarded by bufferLock. */
    private Batch retryBatch;
    /** Queue, retry, and in-flight events share one hard memory budget. Guarded by bufferLock. */
    private int buffered;
    private final UUID emitterId = UUID.randomUUID();
    private long nextSequence = 1;
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
        Batch batch = nextBatch();
        if (batch == null) {
            requestInFlight.set(false);
            reportDrops();
            return;
        }

        HttpRequest request = requestFor(batch);

        try {
            client.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .whenComplete((response, error) -> {
                    boolean accepted = error == null && response != null
                        && response.statusCode() >= 200 && response.statusCode() < 300;
                    completeBatch(batch, accepted);
                    requestInFlight.set(false);
                    reportDrops();
                });
        } catch (RuntimeException error) {
            completeBatch(batch, false);
            requestInFlight.set(false);
            throw error;
        }
    }

    private HttpRequest requestFor(Batch batch) {
        StringBuilder body = new StringBuilder();
        for (WorldEvent event : batch.events()) {
            if (!body.isEmpty()) body.append('\n');
            body.append(toJson(event));
        }
        return HttpRequest.newBuilder(endpoint)
            .timeout(REQUEST_TIMEOUT)
            .header("content-type", "application/x-ndjson")
            .header("x-internal-key", internalKey)
            .header("x-telemetry-emitter-id", emitterId.toString())
            .header("x-telemetry-sequence", Long.toString(batch.sequence()))
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build();
    }

    private Batch nextBatch() {
        synchronized (bufferLock) {
            if (retryBatch != null) {
                Batch batch = retryBatch;
                retryBatch = null;
                return batch;
            }
            List<WorldEvent> events = new ArrayList<>(BATCH_SIZE);
            queue.drainTo(events, BATCH_SIZE);
            if (events.isEmpty()) return null;
            return new Batch(nextSequence++, List.copyOf(events));
        }
    }

    private void completeBatch(Batch batch, boolean accepted) {
        synchronized (bufferLock) {
            if (accepted) {
                buffered -= batch.events().size();
                return;
            }
            if (closed.get()) {
                buffered -= batch.events().size();
                dropped.addAndGet(batch.events().size());
                return;
            }
            // This batch is older than everything still in queue. Keeping it
            // separate makes the next attempt preserve event-time order.
            retryBatch = batch;
        }
    }

    private void discardWaiting() {
        synchronized (bufferLock) {
            int waiting = queue.size() + (retryBatch == null ? 0 : retryBatch.events().size());
            queue.clear();
            retryBatch = null;
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
        // Plugin disable runs on the game thread. Never perform synchronous I/O
        // here; the in-flight callback accounts for its own batch and all
        // waiting data is dropped within the fixed memory bound.
        discardWaiting();
        reportDrops();
    }
}
