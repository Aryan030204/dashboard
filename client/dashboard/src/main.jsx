import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import './index.css';
import App from './App.jsx';
import { Provider } from 'react-redux';
import { store } from './state/store.js';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { initFrontendObservability } from './observability.js';
import ObservabilityErrorBoundary from './components/ObservabilityErrorBoundary.jsx';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';

initFrontendObservability();

// New deploy = new hashed JS/CSS filenames; the old service worker keeps
// serving the previous build's index.html (referencing chunks Vercel no
// longer has) until it's replaced, which without this only happened on a
// hard refresh. `immediate: true` registers on load; once the new worker
// activates (skipWaiting/clientsClaim above), reload so the next request
// actually gets the current build instead of a stale, now-404ing bundle.
if ('serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      registration && setInterval(() => registration.update(), 60 * 60 * 1000);
    },
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <ObservabilityErrorBoundary>
          <App />
        </ObservabilityErrorBoundary>
      </BrowserRouter>
      <ToastContainer position="top-center" delay={5000} />
    </Provider>
  </StrictMode>,
);
