package com.farlands.proxy;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import org.slf4j.Logger;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Publishes fresh route rosters, polls durable transfer instructions, and moves
 * only the named players that are still connected to the instruction's source
 * route. The TCP session to Velocity never drops.
 */
public final class TransferSyncTask implements Runnable {

    private static final int MAX_ACK_CACHE = 2048;

    private final ProxyServer proxy;
    private final Logger logger;
    private final HttpClient httpClient;
    private final Gson gson;
    private final Map<String, AckBody> completed = new LinkedHashMap<>();

    public TransferSyncTask(ProxyServer proxy, Logger logger) {
        this.proxy = proxy;
        this.logger = logger;
        this.gson = new Gson();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                .build();
    }

    @Override
    public void run() {
        if (PluginConfig.API_SECRET.isBlank()) {
            logger.error("[FarlandsProxy] Refusing internal API calls: FARLANDS_API_SECRET is required.");
            return;
        }
        try {
            publishRoster();
            HttpRequest request = authorizedRequest("/internal/velocity/transfers")
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) return;

            List<TransferInstruction> transfers = gson.fromJson(
                    response.body(),
                    new TypeToken<List<TransferInstruction>>(){}.getType()
            );
            if (transfers == null) return;
            for (TransferInstruction transfer : transfers) {
                if (transfer.transferId == null) continue;
                AckBody cached = completed.get(transfer.transferId);
                if (cached != null) {
                    ack(transfer.transferId, cached);
                    continue;
                }
                AckBody result = execute(transfer);
                remember(transfer.transferId, result);
                ack(transfer.transferId, result);
            }
        } catch (Exception ex) {
            logger.debug("[FarlandsProxy] transfer poll failed: {}", ex.getMessage());
        }
    }

    private HttpRequest.Builder authorizedRequest(String path) {
        return HttpRequest.newBuilder()
                .uri(URI.create(PluginConfig.API_BASE_URL + path))
                .timeout(Duration.ofSeconds(PluginConfig.HTTP_TIMEOUT_SECONDS))
                .header("X-Internal-Key", PluginConfig.API_SECRET);
    }

    private void publishRoster() throws Exception {
        Map<String, List<String>> playersByRoute = new LinkedHashMap<>();
        for (Player player : proxy.getAllPlayers()) {
            player.getCurrentServer().ifPresent(connection ->
                    playersByRoute
                            .computeIfAbsent(connection.getServerInfo().getName(), ignored -> new ArrayList<>())
                            .add(player.getUsername()));
        }

        List<RouteRoster> routes = new ArrayList<>();
        for (RegisteredServer server : proxy.getAllServers()) {
            InetSocketAddress address = server.getServerInfo().getAddress();
            routes.add(new RouteRoster(
                    server.getServerInfo().getName(),
                    address.getHostString(),
                    address.getPort(),
                    playersByRoute.getOrDefault(server.getServerInfo().getName(), List.of())
            ));
        }

        String body = gson.toJson(new RosterBody(routes));
        HttpRequest request = authorizedRequest("/internal/velocity/roster")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> response =
                httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IllegalStateException("roster report returned HTTP " + response.statusCode());
        }
    }

    private AckBody execute(TransferInstruction transfer) {
        List<String> requested = transfer.players == null ? List.of() : transfer.players;
        Optional<RegisteredServer> target = proxy.getServer(transfer.toRoute);
        if (target.isEmpty()) {
            return new AckBody(List.of(), requested.stream()
                    .map(player -> failure(player, "target route not registered: " + transfer.toRoute))
                    .toList());
        }

        List<String> moved = new ArrayList<>();
        List<AckFailure> failures = new ArrayList<>();
        for (String username : requested) {
            Optional<Player> selected = proxy.getPlayer(username);
            if (selected.isEmpty()) {
                failures.add(failure(username, "player disconnected before transfer"));
                continue;
            }

            Player player = selected.get();
            Optional<String> currentRoute = player.getCurrentServer()
                    .map(connection -> connection.getServerInfo().getName());
            if (currentRoute.isEmpty() || !currentRoute.get().equals(transfer.fromRoute)) {
                failures.add(failure(username, "player is no longer in source route"));
                continue;
            }

            try {
                player.createConnectionRequest(target.get()).connect().join();
                moved.add(player.getUsername());
            } catch (Exception ex) {
                failures.add(failure(username, String.valueOf(ex.getMessage())));
            }
        }
        return new AckBody(moved, failures);
    }

    private void remember(String transferId, AckBody ack) {
        completed.put(transferId, ack);
        while (completed.size() > MAX_ACK_CACHE) {
            String oldest = completed.keySet().iterator().next();
            completed.remove(oldest);
        }
    }

    private void ack(String id, AckBody ack) {
        try {
            String body = gson.toJson(ack);
            HttpRequest request = authorizedRequest("/internal/velocity/transfers/" + id + "/ack")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response =
                    httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                logger.warn("[FarlandsProxy] transfer ack {} returned HTTP {}", id, response.statusCode());
            }
        } catch (Exception ex) {
            logger.warn("[FarlandsProxy] transfer ack failed for {}: {}", id, ex.getMessage());
        }
    }

    private static AckFailure failure(String player, String reason) {
        AckFailure failure = new AckFailure();
        failure.player = player;
        failure.reason = reason;
        return failure;
    }

    static final class RosterBody {
        final List<RouteRoster> routes;
        RosterBody(List<RouteRoster> routes) {
            this.routes = routes;
        }
    }

    static final class RouteRoster {
        final String route;
        final String targetHost;
        final int targetPort;
        final List<String> players;
        RouteRoster(String route, String targetHost, int targetPort, List<String> players) {
            this.route = route;
            this.targetHost = targetHost;
            this.targetPort = targetPort;
            this.players = players;
        }
    }

    static final class AckBody {
        final List<String> movedPlayers;
        final List<AckFailure> failures;
        AckBody(List<String> movedPlayers, List<AckFailure> failures) {
            this.movedPlayers = movedPlayers;
            this.failures = failures;
        }
    }

    static final class AckFailure {
        String player;
        String reason;
    }
}
