import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import './index.css';
import './styles/datum-tokens.css';
import './styles/datum.css';
import App from './App.jsx';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage.jsx';
import TermsOfServicePage from './pages/TermsOfServicePage.jsx';
import { Provider } from 'react-redux';
import { store } from './state/store.js';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { initFrontendObservability } from './observability.js';
import ObservabilityErrorBoundary from './components/ObservabilityErrorBoundary.jsx';
import { BrowserRouter } from 'react-router-dom';

initFrontendObservability();

// Public, standalone pages that must render without the authenticated app.
const PUBLIC_PAGES = {
  '/privacy-policy': PrivacyPolicyPage,
  '/terms-of-service': TermsOfServicePage,
};
const PublicPage =
  PUBLIC_PAGES[window.location.pathname.replace(/\/+$/, '').toLowerCase()];

createRoot(document.getElementById('root')).render(
  PublicPage ? (
    <StrictMode>
      <PublicPage />
    </StrictMode>
  ) : (
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <ObservabilityErrorBoundary>
          <App />
        </ObservabilityErrorBoundary>
      </BrowserRouter>
      <ToastContainer position="top-center" delay={5000} />
    </Provider>
  </StrictMode>
  ),
);
