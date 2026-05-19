import { Trade } from "@/components/Trade";
import { TopNav } from "@/components/TopNav";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-[#050505]">
      <TopNav />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4">
        <Trade />
      </main>
    </div>
  );
}
