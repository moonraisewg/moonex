import { MarketsList } from "@/components/MarketsList";
import { TopNav } from "@/components/TopNav";

export default function MarketsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#050505]">
      <TopNav />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4">
        <MarketsList />
      </main>
    </div>
  );
}
