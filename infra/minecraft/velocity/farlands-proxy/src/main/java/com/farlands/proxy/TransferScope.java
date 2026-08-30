package com.farlands.proxy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Pure source-realm selection used before any Velocity connection request. */
final class TransferScope {
    record Failure(String player, String reason) {}
    record Plan(List<String> eligible, List<String> alreadyMoved, List<Failure> failures) {}

    static boolean matchesSource(String expectedRoute, String currentRoute) {
        return expectedRoute != null && expectedRoute.equals(currentRoute);
    }

    static Plan plan(
            List<String> requestedPlayers,
            String sourceRoute,
            String targetRoute,
            Map<String, String> routes
    ) {
        List<String> eligible = new ArrayList<>();
        List<String> alreadyMoved = new ArrayList<>();
        List<Failure> failures = new ArrayList<>();
        for (String player : requestedPlayers) {
            String currentRoute = routes.get(player);
            if (currentRoute == null) {
                failures.add(new Failure(player, "player disconnected before transfer"));
            } else if (targetRoute != null && targetRoute.equals(currentRoute)) {
                // The proxy may have restarted after the connection succeeded but
                // before its acknowledgement reached the API. Treat the durable
                // destination state as an idempotent success.
                alreadyMoved.add(player);
            } else if (!matchesSource(sourceRoute, currentRoute)) {
                failures.add(new Failure(player, "player is no longer in source route"));
            } else {
                eligible.add(player);
            }
        }
        return new Plan(List.copyOf(eligible), List.copyOf(alreadyMoved), List.copyOf(failures));
    }

    private TransferScope() {}
}
