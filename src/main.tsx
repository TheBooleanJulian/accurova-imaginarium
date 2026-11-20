import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@xyflow/react/dist/style.css';
import './styles/tokens.css';
import './styles/index.css';
import { initTheme } from './lib/theme';
import { App } from './App';
import { createRepository } from './data';
import { RepoProvider } from './lib/repoContext';

initTheme();

const root = createRoot(document.getElementById('root')!);

createRepository()
  .then((repo) =>
    root.render(
      <StrictMode>
        <RepoProvider repo={repo}>
          <App />
        </RepoProvider>
      </StrictMode>,
    ),
  )
  .catch((e) => {
    root.render(
      <div style={{ padding: 32, fontFamily: 'monospace', color: 'var(--danger)' }}>
        Accurova Imaginarium failed to start: {String(e?.message ?? e)}
      </div>,
    );
  });
