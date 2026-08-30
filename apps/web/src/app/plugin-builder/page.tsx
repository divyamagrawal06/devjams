import { redirect } from "next/navigation";

import { desktopRoute } from "@/lib/routes";

export default function PluginBuilderRedirect() {
  redirect(desktopRoute("rule-forge"));
}
