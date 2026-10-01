// Every page reads live data from the API, so none of them are prerendered at build time.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>FlakeHunter</h1>
      <p>The dashboard is being built.</p>
    </main>
  );
}
