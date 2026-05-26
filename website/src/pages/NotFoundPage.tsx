export function NotFoundPage() {
  return (
    <section class="section">
      <div class="container container-narrow" style="text-align: center;">
        <p class="eyebrow">404</p>
        <h1 style="margin-bottom: 20px;">That page isn't here.</h1>
        <p class="lead" style="margin: 0 auto 32px;">
          The link you followed doesn't match any route on this site. Try the overview, or head
          back to the homepage.
        </p>
        <div class="hero-cta" style="justify-content: center;">
          <a class="btn btn-primary" href="/">Back to overview</a>
          <a class="btn btn-secondary" href="/docs">Read the docs</a>
        </div>
      </div>
    </section>
  );
}
