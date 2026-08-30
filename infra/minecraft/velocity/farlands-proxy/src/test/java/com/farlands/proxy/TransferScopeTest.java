package com.farlands.proxy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class TransferScopeTest {
    @Test
    void selectsOnlyNamedPlayersStillInTheSourceRealm() {
        TransferScope.Plan plan = TransferScope.plan(
                List.of("Alice", "Bob", "Carol", "Mallory"),
                "realm-a",
                "realm-b",
                Map.of("Alice", "realm-a", "Bob", "realm-b", "Carol", "realm-c")
        );

        assertEquals(List.of("Alice"), plan.eligible());
        assertEquals(List.of("Bob"), plan.alreadyMoved());
        assertEquals(List.of("Carol", "Mallory"),
                plan.failures().stream().map(TransferScope.Failure::player).toList());
        assertTrue(TransferScope.matchesSource("realm-a", "realm-a"));
        assertFalse(TransferScope.matchesSource("realm-a", "realm-b"));
        assertFalse(TransferScope.matchesSource("realm-a", null));
    }

    @Test
    void treatsDestinationPresenceAsSuccessAfterProxyRestart() {
        TransferScope.Plan plan = TransferScope.plan(
                List.of("Alice"), "lobby", "realm-b", Map.of("Alice", "realm-b"));

        assertEquals(List.of(), plan.eligible());
        assertEquals(List.of("Alice"), plan.alreadyMoved());
        assertEquals(List.of(), plan.failures());
    }
}
