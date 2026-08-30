package com.farlands.proxy;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

final class TransferAttemptTest {
    @Test
    void retryAttemptGetsANewProxyIdempotencyKey() {
        assertEquals("tx_change:1", TransferSyncTask.attemptKey("tx_change", 1));
        assertNotEquals(
                TransferSyncTask.attemptKey("tx_change", 1),
                TransferSyncTask.attemptKey("tx_change", 2));
    }

    @Test
    void invalidAttemptsAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> TransferSyncTask.attemptKey("tx_change", 0));
    }
}
