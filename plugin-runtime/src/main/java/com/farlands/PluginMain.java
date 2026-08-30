package com.farlands;

import org.bukkit.plugin.java.JavaPlugin;

import com.farlands.listeners.JoinListener;
import com.farlands.listeners.QuitListener;
import com.farlands.listeners.ActionListener;
import com.farlands.telemetry.TelemetryEmitter;
import com.farlands.telemetry.TelemetryListener;

public class PluginMain extends JavaPlugin {
    private TelemetryEmitter telemetryEmitter;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        
        getServer().getPluginManager().registerEvents(
            new JoinListener(this),
            this
        );

        getServer().getPluginManager().registerEvents(
            new QuitListener(this),
            this
        );

        getServer().getPluginManager().registerEvents(
            new ActionListener(this),
            this
        );

        TelemetryEmitter.fromEnvironment(getLogger()).ifPresent(emitter -> {
            telemetryEmitter = emitter;
            getServer().getPluginManager().registerEvents(new TelemetryListener(emitter), this);
            getLogger().info("Privacy-aware aggregate telemetry enabled");
        });

        getLogger().info("Farlands Plugin Enabled");
    }

    @Override
    public void onDisable() {
        if (telemetryEmitter != null) telemetryEmitter.close();
        getLogger().info("Farlands Plugin Disabled");
    }
}
