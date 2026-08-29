import { redirect } from "next/navigation";

import { desktopRoute } from "@/lib/routes";

export default function ProposalsRedirect() {
  redirect(desktopRoute("review-queue"));
}
