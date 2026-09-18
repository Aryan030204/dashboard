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

initFrontendObservability();

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
