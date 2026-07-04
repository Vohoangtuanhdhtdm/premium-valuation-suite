import { createFileRoute } from "@tanstack/react-router";
import { ValuationApp } from "@/components/valuation/ValuationApp";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <ValuationApp />;
}
