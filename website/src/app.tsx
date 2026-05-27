import { LocationProvider, Router, Route, useLocation } from 'preact-iso';
import { IndexPage } from './pages/IndexPage';
import { AboutPage } from './pages/AboutPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { DocsPage } from './pages/DocsPage';
import { DownloadPage } from './pages/DownloadPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SiteHeader } from './components/SiteHeader/SiteHeader';
import { SiteFooter } from './components/SiteFooter/SiteFooter';
import { usePageTransitions } from './hooks/usePageTransitions';

export function App() {
  return (
    <LocationProvider>
      <AppShell />
    </LocationProvider>
  );
}

/**
 * Inner shell — exists separately so `usePageTransitions` can call
 * `useLocation` (which only works under a LocationProvider). Also
 * keys the route container on path so each route mount triggers the
 * CSS entrance animation as a fallback for browsers without the
 * View Transitions API.
 */
function AppShell() {
  const { path } = useLocation();
  usePageTransitions();
  return (
    <>
      <SiteHeader />
      <main class="route-content" key={path}>
        <Router>
          <Route path="/" component={IndexPage} />
          <Route path="/about" component={AboutPage} />
          <Route path="/discover" component={DiscoverPage} />
          <Route path="/docs" component={DocsPage} />
          <Route path="/download" component={DownloadPage} />
          <Route default component={NotFoundPage} />
        </Router>
      </main>
      <SiteFooter />
    </>
  );
}
