const checks = [
  "Next.js App Router",
  "tRPC route",
  "Prisma Client",
  "PostgreSQL / Redis via Docker Compose",
];

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Day 47 scaffold</p>
        <h1>SaaS Task Platform</h1>
        <p className="lead">
          Next.js, tRPC, Prisma, PostgreSQL, and Redis are wired into a runnable
          base for the collaborative task platform designed on Day 46.
        </p>
        <a className="button" href="/api/trpc/health.ping">
          Check health
        </a>
      </section>

      <section className="panel" aria-label="Scaffold checks">
        {checks.map((check) => (
          <div className="row" key={check}>
            <span className="dot" aria-hidden="true" />
            <span>{check}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
