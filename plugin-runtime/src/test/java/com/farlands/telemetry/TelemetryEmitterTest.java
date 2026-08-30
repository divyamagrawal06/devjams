package com.farlands.telemetry;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;

final class TelemetryEmitterTest {
    private static final Constructor<TelemetryEmitter> CONSTRUCTOR;
    private static final Method FLUSH;
    private static final Field IN_FLIGHT;

    static {
        try {
            CONSTRUCTOR = TelemetryEmitter.class.getDeclaredConstructor(
                URI.class,
                String.class,
                Logger.class
            );
            CONSTRUCTOR.setAccessible(true);
            FLUSH = TelemetryEmitter.class.getDeclaredMethod("flush");
            FLUSH.setAccessible(true);
            IN_FLIGHT = TelemetryEmitter.class.getDeclaredField("requestInFlight");
            IN_FLIGHT.setAccessible(true);
        } catch (ReflectiveOperationException error) {
            throw new ExceptionInInitializerError(error);
        }
    }

    @Test
    void retryKeepsEmitterIdentitySequenceAndPayload() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        List<String> emitterIds = new CopyOnWriteArrayList<>();
        List<String> sequences = new CopyOnWriteArrayList<>();
        List<String> bodies = new CopyOnWriteArrayList<>();
        HttpServer server = server();
        server.createContext("/telemetry", exchange -> {
            emitterIds.add(exchange.getRequestHeaders().getFirst("x-telemetry-emitter-id"));
            sequences.add(exchange.getRequestHeaders().getFirst("x-telemetry-sequence"));
            bodies.add(new String(exchange.getRequestBody().readAllBytes()));
            int call = calls.incrementAndGet();
            exchange.sendResponseHeaders(call == 1 ? 503 : 200, -1);
            exchange.close();
        });
        server.start();

        TelemetryEmitter emitter = emitter(server, "/telemetry");
        try {
            emitter.emit(event("first"));
            flushAndWait(emitter, calls, 1);
            emitter.emit(event("second"));
            flushAndWait(emitter, calls, 2);
            flushAndWait(emitter, calls, 3);

            assertEquals(emitterIds.get(0), emitterIds.get(1));
            assertEquals(emitterIds.get(1), emitterIds.get(2));
            assertEquals(List.of("1", "1", "2"), sequences);
            assertEquals(bodies.get(0), bodies.get(1));
            assertTrue(bodies.get(2).contains("second"));
        } finally {
            emitter.close();
            server.stop(0);
        }
    }

    @Test
    void closeNeverWaitsForAnInFlightRequest() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        HttpServer server = server();
        server.createContext("/slow", exchange -> {
            started.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
                exchange.sendResponseHeaders(200, -1);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.start();

        TelemetryEmitter emitter = emitter(server, "/slow");
        try {
            emitter.emit(event("pending"));
            FLUSH.invoke(emitter);
            assertTrue(started.await(2, TimeUnit.SECONDS));

            long startedAt = System.nanoTime();
            emitter.close();
            assertTrue(Duration.ofNanos(System.nanoTime() - startedAt).toMillis() < 200);
        } finally {
            release.countDown();
            server.stop(0);
        }
    }

    private static HttpServer server() throws Exception {
        return HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    }

    private static TelemetryEmitter emitter(HttpServer server, String path) throws Exception {
        Logger logger = Logger.getAnonymousLogger();
        logger.setUseParentHandlers(false);
        URI endpoint = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path);
        return CONSTRUCTOR.newInstance(endpoint, "internal-test-key", logger);
    }

    private static TelemetryEmitter.WorldEvent event(String subject) {
        return new TelemetryEmitter.WorldEvent(
            "block_broken",
            Instant.now(),
            "player",
            null,
            subject,
            1
        );
    }

    private static void flushAndWait(
        TelemetryEmitter emitter,
        AtomicInteger calls,
        int expected
    ) throws Exception {
        FLUSH.invoke(emitter);
        waitUntil(() -> calls.get() >= expected, "request was not delivered");
        AtomicBoolean inFlight = (AtomicBoolean) IN_FLIGHT.get(emitter);
        waitUntil(() -> !inFlight.get(), "request did not settle");
    }

    private static void waitUntil(Check check, String message) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!check.ok() && System.nanoTime() < deadline) Thread.sleep(5);
        if (!check.ok()) throw new AssertionError(message);
    }

    @FunctionalInterface
    private interface Check {
        boolean ok() throws Exception;
    }
}
