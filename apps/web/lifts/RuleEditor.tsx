"use client";
import { FlaskConical, Gift, Megaphone, MessageSquare, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const MINECRAFT_ITEMS: string[] = [
  "ACACIA_LOG",
  "ACACIA_PLANKS",
  "ACACIA_SAPLING",
  "APPLE",
  "ARROW",
  "BAKED_POTATO",
  "BAMBOO",
  "BEEF",
  "BIRCH_LOG",
  "BIRCH_PLANKS",
  "BLAZE_POWDER",
  "BLAZE_ROD",
  "BONE",
  "BONE_MEAL",
  "BOOK",
  "BOW",
  "BREAD",
  "BRICK",
  "BUCKET",
  "CACTUS",
  "CAKE",
  "CARROT",
  "CHARCOAL",
  "CHEST",
  "CHICKEN",
  "CHORUS_FRUIT",
  "CLAY_BALL",
  "COAL",
  "COBBLESTONE",
  "COD",
  "COMPASS",
  "COOKED_BEEF",
  "COOKED_CHICKEN",
  "COOKED_COD",
  "COOKED_MUTTON",
  "COOKED_PORKCHOP",
  "COOKED_RABBIT",
  "COOKED_SALMON",
  "COOKIE",
  "CROSSBOW",
  "DARK_OAK_LOG",
  "DARK_OAK_PLANKS",
  "DIAMOND",
  "DIAMOND_AXE",
  "DIAMOND_BOOTS",
  "DIAMOND_CHESTPLATE",
  "DIAMOND_HELMET",
  "DIAMOND_HOE",
  "DIAMOND_LEGGINGS",
  "DIAMOND_PICKAXE",
  "DIAMOND_SHOVEL",
  "DIAMOND_SWORD",
  "DIRT",
  "EGG",
  "EMERALD",
  "ENCHANTED_BOOK",
  "ENDER_PEARL",
  "EXPERIENCE_BOTTLE",
  "FEATHER",
  "FERMENTED_SPIDER_EYE",
  "FISHING_ROD",
  "FLINT",
  "FLINT_AND_STEEL",
  "FLOWER_POT",
  "FURNACE",
  "GLASS",
  "GLASS_BOTTLE",
  "GLOWSTONE_DUST",
  "GOLD_INGOT",
  "GOLD_NUGGET",
  "GOLDEN_APPLE",
  "GOLDEN_AXE",
  "GOLDEN_BOOTS",
  "GOLDEN_CHESTPLATE",
  "GOLDEN_HELMET",
  "GOLDEN_HOE",
  "GOLDEN_LEGGINGS",
  "GOLDEN_PICKAXE",
  "GOLDEN_SHOVEL",
  "GOLDEN_SWORD",
  "GRAVEL",
  "GUNPOWDER",
  "HAY_BLOCK",
  "IRON_AXE",
  "IRON_BOOTS",
  "IRON_CHESTPLATE",
  "IRON_HELMET",
  "IRON_HOE",
  "IRON_INGOT",
  "IRON_LEGGINGS",
  "IRON_NUGGET",
  "IRON_PICKAXE",
  "IRON_SHOVEL",
  "IRON_SWORD",
  "JUNGLE_LOG",
  "JUNGLE_PLANKS",
  "LADDER",
  "LAPIS_LAZULI",
  "LEATHER",
  "LEATHER_BOOTS",
  "LEATHER_CHESTPLATE",
  "LEATHER_HELMET",
  "LEATHER_LEGGINGS",
  "MELON_SLICE",
  "MILK_BUCKET",
  "MUSHROOM_STEW",
  "MUTTON",
  "NETHERITE_INGOT",
  "NETHERITE_SWORD",
  "NETHERITE_PICKAXE",
  "NETHERITE_AXE",
  "OAK_LOG",
  "OAK_PLANKS",
  "OAK_SAPLING",
  "OBSIDIAN",
  "PAPER",
  "PHANTOM_MEMBRANE",
  "PORKCHOP",
  "POTATO",
  "PUMPKIN",
  "PUMPKIN_PIE",
  "RABBIT",
  "RABBIT_STEW",
  "REDSTONE",
  "ROTTEN_FLESH",
  "SALMON",
  "SAND",
  "SANDSTONE",
  "SHIELD",
  "SLIMEBALL",
  "SNOWBALL",
  "SOUL_SAND",
  "SPIDER_EYE",
  "SPRUCE_LOG",
  "SPRUCE_PLANKS",
  "STICK",
  "STONE",
  "STONE_AXE",
  "STONE_BRICKS",
  "STONE_PICKAXE",
  "STONE_SHOVEL",
  "STONE_SWORD",
  "STRING",
  "SUGAR",
  "SUGAR_CANE",
  "SUSPICIOUS_STEW",
  "TORCH",
  "TOTEM_OF_UNDYING",
  "TRIDENT",
  "TURTLE_HELMET",
  "VINE",
  "WATER_BUCKET",
  "WHEAT",
  "WHEAT_SEEDS",
  "WHITE_WOOL",
  "WOODEN_AXE",
  "WOODEN_HOE",
  "WOODEN_PICKAXE",
  "WOODEN_SHOVEL",
  "WOODEN_SWORD",
];

const RULE_ICON_MAP: Record<string, React.ReactNode> = {
  welcome_message: <MessageSquare className="h-4 w-4 text-primary" />,
  broadcast_announcement: <Megaphone className="h-4 w-4 text-primary" />,
  starter_kit: <Gift className="h-4 w-4 text-primary" />,
  potion_effect: <FlaskConical className="h-4 w-4 text-primary" />,
  player_action: <Zap className="h-4 w-4 text-primary" />,
};

const RULE_LABEL_MAP: Record<string, string> = {
  welcome_message: "Welcome Message",
  broadcast_announcement: "Broadcast Announcement",
  starter_kit: "Starter Kit",
  potion_effect: "Potion Effect",
  player_action: "Player Action",
};

export interface Rule {
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
}

type RuleEditorProps = {
  rules: Rule[];
  deleteRule: (id: number) => void;
  changeType: (id: number, value: string) => void;
  changeEvent: (id: number, value: string) => void;
  changeMessage: (id: number, value: string) => void;
  changeBroadcastMessage: (id: number, value: string) => void;
  addStarterKitItem: (id: number) => void;
  changeStarterKitItem: (ruleId: number, itemIndex: number, value: string) => void;
  changeStarterKitAmount: (ruleId: number, itemIndex: number, value: number) => void;
  removeStarterKitItem: (ruleId: number, itemIndex: number) => void;
  changePotionEffect: (id: number, value: string) => void;
  changeAmplifier: (id: number, value: number) => void;
  changeDuration: (id: number, value: number) => void;
  changeActionType: (id: number, value: string) => void;
  changeActionAmount: (id: number, value: number) => void;
  getAllowedEvents: (ruleType: string) => { value: string; label: string }[];
};

export function RuleEditor({
  rules,
  deleteRule,
  changeType,
  changeEvent,
  changeMessage,
  changeBroadcastMessage,
  addStarterKitItem,
  changeStarterKitItem,
  changeStarterKitAmount,
  removeStarterKitItem,
  changePotionEffect,
  changeAmplifier,
  changeDuration,
  changeActionType,
  changeActionAmount,
  getAllowedEvents,
}: RuleEditorProps) {
  return (
    <div className="space-y-4">
      {rules.map((rule, index) => (
        <Card key={rule.id} className="glass-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4 border-b border-white/10">
            <CardTitle className="flex items-center gap-2.5 text-sm font-semibold text-white">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 backdrop-blur-md">
                {RULE_ICON_MAP[rule.type] ?? <Zap className="h-4 w-4 text-primary" />}
              </div>
              <span>Rule {index + 1}</span>
              <span className="text-xs font-normal text-muted-foreground">
                — {RULE_LABEL_MAP[rule.type] ?? rule.type}
              </span>
            </CardTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              onClick={() => deleteRule(rule.id)}
              title="Delete rule"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </CardHeader>

          <CardContent className="space-y-5 pt-4">
            {/* Rule Type + Event */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                  Rule Type
                </Label>
                <Select value={rule.type} onValueChange={(val) => changeType(rule.id, val)}>
                  <SelectTrigger className="border-white/10 bg-white/5">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="welcome_message">Welcome Message</SelectItem>
                    <SelectItem value="broadcast_announcement">Broadcast Announcement</SelectItem>
                    <SelectItem value="starter_kit">Starter Kit</SelectItem>
                    <SelectItem value="potion_effect">Potion Effect</SelectItem>
                    <SelectItem value="player_action">Player Action</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                  Trigger Event
                </Label>
                <Select value={rule.event} onValueChange={(val) => changeEvent(rule.id, val)}>
                  <SelectTrigger className="border-white/10 bg-white/5">
                    <SelectValue placeholder="Select event" />
                  </SelectTrigger>
                  <SelectContent>
                    {getAllowedEvents(rule.type).map((event) => (
                      <SelectItem key={event.value} value={event.value}>
                        {event.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Rule-specific controls */}
            {rule.type === "welcome_message" && (
              <div className="space-y-2">
                <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                  Welcome Message
                </Label>
                <Textarea
                  value={rule.message}
                  onChange={(e) => changeMessage(rule.id, e.target.value)}
                  rows={3}
                  placeholder="Enter the message players will see when they join..."
                  className="border-white/10 bg-white/5 placeholder:text-muted-foreground resize-none"
                />
              </div>
            )}

            {rule.type === "broadcast_announcement" && (
              <div className="space-y-2">
                <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                  Broadcast Message
                </Label>
                <Textarea
                  value={rule.broadcastMessage}
                  onChange={(e) => changeBroadcastMessage(rule.id, e.target.value)}
                  rows={3}
                  placeholder="Enter the message to broadcast to all players..."
                  className="border-white/10 bg-white/5 placeholder:text-muted-foreground resize-none"
                />
              </div>
            )}

            {rule.type === "starter_kit" && (
              <div className="space-y-3">
                <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                  Starter Kit Items
                </Label>
                <div className="space-y-2">
                  {rule.starterKitItems.map((item, idx) => (
                    // This frozen lift models starter-kit edits by position;
                    // changing its snapshot data shape would make the lift diverge.
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional identity is intentional in this unshipped lift
                    <div key={idx} className="flex items-center gap-2">
                      <Select
                        value={item.material}
                        onValueChange={(val) => changeStarterKitItem(rule.id, idx, val)}
                      >
                        <SelectTrigger className="flex-1 border-white/10 bg-white/5">
                          <SelectValue placeholder="Select item" />
                        </SelectTrigger>
                        <SelectContent>
                          {MINECRAFT_ITEMS.map((mcItem) => (
                            <SelectItem key={mcItem} value={mcItem}>
                              {mcItem}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min="1"
                        value={item.amount}
                        onChange={(e) =>
                          changeStarterKitAmount(rule.id, idx, Number(e.target.value))
                        }
                        className="w-20 border-white/10 bg-white/5"
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => removeStarterKitItem(rule.id, idx)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-white/10 bg-white/5 text-white hover:bg-white/10 text-xs"
                  onClick={() => addStarterKitItem(rule.id)}
                >
                  <Plus className="mr-1.5 h-3 w-3" /> Add Item
                </Button>
              </div>
            )}

            {rule.type === "potion_effect" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                    Effect
                  </Label>
                  <Select
                    value={rule.potionEffect}
                    onValueChange={(val) => changePotionEffect(rule.id, val)}
                  >
                    <SelectTrigger className="border-white/10 bg-white/5">
                      <SelectValue placeholder="Select effect" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="speed">Speed</SelectItem>
                      <SelectItem value="strength">Strength</SelectItem>
                      <SelectItem value="jump_boost">Jump Boost</SelectItem>
                      <SelectItem value="regeneration">Regeneration</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                    Amplifier
                  </Label>
                  <Input
                    type="number"
                    value={rule.amplifier}
                    onChange={(e) => changeAmplifier(rule.id, Number(e.target.value))}
                    className="border-white/10 bg-white/5"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                    Duration (sec)
                  </Label>
                  <Input
                    type="number"
                    value={rule.duration}
                    onChange={(e) => changeDuration(rule.id, Number(e.target.value))}
                    className="border-white/10 bg-white/5"
                  />
                </div>
              </div>
            )}

            {rule.type === "player_action" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                    Action Type
                  </Label>
                  <Select
                    value={rule.actionType}
                    onValueChange={(val) => changeActionType(rule.id, val)}
                  >
                    <SelectTrigger className="border-white/10 bg-white/5">
                      <SelectValue placeholder="Select action" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="give_xp">Give XP</SelectItem>
                      <SelectItem value="heal">Heal Player</SelectItem>
                      <SelectItem value="feed">Feed Player</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-white/70 uppercase tracking-wider">
                    Amount
                  </Label>
                  <Input
                    type="number"
                    value={rule.actionAmount}
                    onChange={(e) => changeActionAmount(rule.id, Number(e.target.value))}
                    className="border-white/10 bg-white/5"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
