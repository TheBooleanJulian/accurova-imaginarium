import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@xyflow/react/dist/style.css';
import './styles/index.css';
import { App } from './App';
import { createRepository } from './data';
import { RepoProvider } from './lib/repoContext';

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
      <div style={{ padding: 32, fontFamily: 'monospace', color: '#ff6b6b' }}>
        Accurova Imaginarium failed to start: {String(e?.message ?? e)}
      </div>,
    );
  });
