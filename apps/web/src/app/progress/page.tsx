import { redirect } from "next/navigation";

import { desktopRoute } from "@/lib/routes";

export default function ProgressRedirect() {
  redirect(desktopRoute("deployments"));
}
