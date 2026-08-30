package com.farlands.telemetry;

import java.time.Instant;

import io.papermc.paper.event.player.AsyncChatEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/** Converts a fixed event vocabulary into counters; chat content is never read. */
public final class TelemetryListener implements Listener {
    private final TelemetryEmitter emitter;

    public TelemetryListener(TelemetryEmitter emitter) {
        this.emitter = emitter;
    }

    private void emit(String kind, String playerName, String subject) {
        emitter.emit(new TelemetryEmitter.WorldEvent(
            kind,
            Instant.now(),
            playerName,
            null,
            subject,
            1
        ));
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        emit("join", event.getPlayer().getName(), null);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        emit("leave", event.getPlayer().getName(), null);
    }

    @EventHandler
    public void onDeath(PlayerDeathEvent event) {
        emit("death", event.getEntity().getName(), null);
    }

    @EventHandler
    public void onBlockPlace(BlockPlaceEvent event) {
        emit("block_placed", event.getPlayer().getName(), event.getBlockPlaced().getType().getKey().toString());
    }

    @EventHandler
    public void onBlockBreak(BlockBreakEvent event) {
        emit("block_broken", event.getPlayer().getName(), event.getBlock().getType().getKey().toString());
    }

    @EventHandler
    public void onChat(AsyncChatEvent event) {
        // Only the count is observed. event.message() is deliberately never called.
        emit("chat_volume", null, null);
    }
}
