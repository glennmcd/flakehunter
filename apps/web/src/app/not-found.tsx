import Link from "next/link";

export default function NotFound() {
  return (
    <main>
      <div className="error">
        <h1>Not found</h1>
        <p>There is nothing at this address.</p>
        <p>
          <Link href="/">Back to repositories</Link>
        </p>
      </div>
    </main>
  );
}
