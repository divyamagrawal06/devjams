"use client";
import { Cpu, Download, Plus } from "lucide-react";
import { useState } from "react";
import { buildJson } from "@/app/api/plugin-builder/json-builder";
import { RuleEditor } from "@/components/RuleEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function PluginBuilderPage() {
  const [pluginName, setPluginName] = useState("");
  const [minecraftVersion, setMinecraftVersion] = useState("1.21.4");
  const [nameError, setNameError] = useState("");
  const [generateStatus, setGenerateStatus] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  const [rules, setRules] = useState<
    {
      id: number;
      type: string;
      event: string;
      message: string;
      broadcastMessage: string;
      starterKitItems: { material: string; amount: number }[];
      potionEffect: string;
      amplifier: number;
      duration: number;
      actionType: string;
      actionAmount: number;
    }[]
  >([]);

  function validateName(value: string) {
    if (!value) {
      setNameError("Plugin Name is required.");
      return false;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      setNameError("Only letters, numbers, _ and - are allowed.");
      return false;
    }
    setNameError("");
    return true;
  }

  function addRule() {
    setRules([
      ...rules,
      {
        id: Date.now(),
        type: "welcome_message",
        event: "player_join",
        message: "",
        broadcastMessage: "",
        starterKitItems: [{ material: "DIAMOND_SWORD", amount: 1 }],
        potionEffect: "speed",
        amplifier: 1,
        duration: 60,
        actionType: "give_xp",
        actionAmount: 10,
      },
    ]);
  }

  function deleteRule(id: number) {
    setRules(rules.filter((rule) => rule.id !== id));
  }

  function changeType(id: number, newType: string) {
    setRules(
      rules.map((rule) => {
        if (rule.id !== id) return rule;
        const allowedEvents = getAllowedEvents(newType);
        return { ...rule, type: newType, event: allowedEvents[0].value };
      }),
    );
  }

  function changeEvent(id: number, newEvent: string) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, event: newEvent } : rule)));
  }

  function changeMessage(id: number, newMessage: string) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, message: newMessage } : rule)));
  }

  function changeBroadcastMessage(id: number, value: string) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, broadcastMessage: value } : rule)));
  }

  function addStarterKitItem(id: number) {
    setRules(
      rules.map((rule) =>
        rule.id === id
          ? {
              ...rule,
              starterKitItems: [...rule.starterKitItems, { material: "BREAD", amount: 1 }],
            }
          : rule,
      ),
    );
  }

  function changeStarterKitItem(ruleId: number, itemIndex: number, value: string) {
    setRules(
      rules.map((rule) => {
        if (rule.id !== ruleId) return rule;
        const newItems = [...rule.starterKitItems];
        newItems[itemIndex] = { ...newItems[itemIndex], material: value };
        return { ...rule, starterKitItems: newItems };
      }),
    );
  }

  function changeStarterKitAmount(ruleId: number, itemIndex: number, value: number) {
    setRules(
      rules.map((rule) => {
        if (rule.id !== ruleId) return rule;
        const newItems = [...rule.starterKitItems];
        newItems[itemIndex] = {
          ...newItems[itemIndex],
          amount: Math.max(1, value || 1),
        };
        return { ...rule, starterKitItems: newItems };
      }),
    );
  }

  function removeStarterKitItem(ruleId: number, itemIndex: number) {
    setRules(
      rules.map((rule) => {
        if (rule.id !== ruleId) return rule;
        return {
          ...rule,
          starterKitItems: rule.starterKitItems.filter((_, i) => i !== itemIndex),
        };
      }),
    );
  }

  function changePotionEffect(id: number, value: string) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, potionEffect: value } : rule)));
  }

  function changeAmplifier(id: number, value: number) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, amplifier: value } : rule)));
  }

  function changeDuration(id: number, value: number) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, duration: value } : rule)));
  }

  function changeActionType(id: number, value: string) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, actionType: value } : rule)));
  }

  function changeActionAmount(id: number, value: number) {
    setRules(rules.map((rule) => (rule.id === id ? { ...rule, actionAmount: value } : rule)));
  }

  function getAllowedEvents(ruleType: string) {
    switch (ruleType) {
      case "welcome_message":
      case "starter_kit":
      case "potion_effect":
        return [{ value: "player_join", label: "Player Join" }];
      case "broadcast_announcement":
      case "player_action":
        return [
          { value: "player_join", label: "Player Join" },
          { value: "player_quit", label: "Player Quit" },
          { value: "player_death", label: "Player Death" },
        ];
      default:
        return [{ value: "player_join", label: "Player Join" }];
    }
  }

  async function generatePlugin() {
    if (!validateName(pluginName)) return;
    if (rules.length === 0) {
      setGenerateStatus("⚠ Add at least one rule before generating.");
      return;
    }
    try {
      setIsGenerating(true);
      setGenerateStatus("Compiling plugin...");
      const response = await fetch("/api/plugin-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildJson(pluginName, minecraftVersion, rules)),
      });
      if (!response.ok) throw new Error(`Compilation failed (HTTP ${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pluginName}.jar`;
      a.click();
      URL.revokeObjectURL(url);
      setGenerateStatus("Build successful. Download started.");
    } catch (err) {
      setGenerateStatus(err instanceof Error ? err.message : "Compilation failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  function downloadJson() {
    const json = buildJson(pluginName, minecraftVersion, rules);
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pluginName || "plugin"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setGenerateStatus("plugin.json downloaded.");
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 backdrop-blur-md">
              <Cpu className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Plugin Builder</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Visually build Minecraft plugins and export production-ready{" "}
            <span className="font-mono text-primary">.jar</span> files.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge className="border border-primary/30 bg-primary/10 text-primary text-xs px-3 py-1">
            {rules.length} rule{rules.length !== 1 ? "s" : ""}
          </Badge>
        </div>
      </div>

      {/* Plugin Configuration Card */}
      <Card className="glass-card">
        <CardHeader className="pb-4">
          <CardTitle className="text-white text-base font-semibold">Plugin Configuration</CardTitle>
          <CardDescription className="text-muted-foreground text-sm">
            Set the name and target Minecraft version for your plugin.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="plugin-name" className="text-sm text-white/80 font-medium">
              Plugin Name
            </Label>
            <Input
              id="plugin-name"
              value={pluginName}
              onChange={(e) => {
                setPluginName(e.target.value);
                validateName(e.target.value);
              }}
              placeholder="e.g. MyAwesomePlugin"
              className="border-white/10 bg-white/5 placeholder:text-muted-foreground"
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>
          <div className="space-y-2">
            <Label className="text-sm text-white/80 font-medium">Minecraft Version</Label>
            <Select value={minecraftVersion} onValueChange={setMinecraftVersion}>
              <SelectTrigger className="border-white/10 bg-white/5">
                <SelectValue placeholder="Select version" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1.21.4">1.21.4</SelectItem>
                <SelectItem value="1.20.6">1.20.6</SelectItem>
                <SelectItem value="1.19.4">1.19.4</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Rules Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white tracking-tight">Rules</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Define what your plugin does in response to game events.
            </p>
          </div>
          <Button
            className="h-9 bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/90 transition-colors"
            onClick={addRule}
            id="add-rule-btn"
          >
            <Plus className="mr-2 h-4 w-4" /> Add Rule
          </Button>
        </div>

        {rules.length === 0 && (
          <Card className="glass-card">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md mb-4">
                <Cpu className="h-7 w-7 text-primary/60" />
              </div>
              <p className="text-base font-medium text-white">No rules yet</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-xs">
                Click <span className="text-primary font-semibold">Add Rule</span> to define your
                first plugin behaviour.
              </p>
            </CardContent>
          </Card>
        )}

        <RuleEditor
          rules={rules}
          deleteRule={deleteRule}
          changeType={changeType}
          changeEvent={changeEvent}
          changeMessage={changeMessage}
          changeBroadcastMessage={changeBroadcastMessage}
          addStarterKitItem={addStarterKitItem}
          changeStarterKitItem={changeStarterKitItem}
          changeStarterKitAmount={changeStarterKitAmount}
          removeStarterKitItem={removeStarterKitItem}
          changePotionEffect={changePotionEffect}
          changeAmplifier={changeAmplifier}
          changeDuration={changeDuration}
          changeActionType={changeActionType}
          changeActionAmount={changeActionAmount}
          getAllowedEvents={getAllowedEvents}
        />
      </div>

      {/* Actions Card */}
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base font-semibold">Export</CardTitle>
          <CardDescription className="text-muted-foreground text-sm">
            Download the compiled plugin or the raw JSON config.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            className="border-white/10 bg-white/5 text-white hover:bg-white/10"
            onClick={downloadJson}
            id="download-json-btn"
          >
            <Download className="mr-2 h-4 w-4" />
            Download JSON
          </Button>
          <Button
            className="bg-primary text-white hover:bg-primary/90 font-semibold transition-colors"
            onClick={() => {
              void generatePlugin();
            }}
            disabled={isGenerating}
            id="generate-plugin-btn"
          >
            <Cpu className="mr-2 h-4 w-4" />
            {isGenerating ? "Compiling..." : "Generate Plugin"}
          </Button>
          {generateStatus && (
            <p
              className={`text-sm ml-1 ${generateStatus.startsWith("⚠") ? "text-destructive" : generateStatus.startsWith("Build") ? "text-secondary" : "text-muted-foreground"}`}
            >
              {generateStatus}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
