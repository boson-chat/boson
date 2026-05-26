import { LocationProvider, Router, Route } from 'preact-iso';
import { IndexPage } from './pages/IndexPage';
import { AboutPage } from './pages/AboutPage';
import { DocsPage } from './pages/DocsPage';
import { DownloadPage } from './pages/DownloadPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SiteHeader } from './components/SiteHeader/SiteHeader';
import { SiteFooter } from './components/SiteFooter/SiteFooter';

export function App() {
  return (
    <LocationProvider>
      <SiteHeader />
      <main>
        <Router>
          <Route path="/" component={IndexPage} />
          <Route path="/about" component={AboutPage} />
          <Route path="/docs" component={DocsPage} />
          <Route path="/download" component={DownloadPage} />
          <Route default component={NotFoundPage} />
        </Router>
      </main>
      <SiteFooter />
    </LocationProvider>
  );
}
