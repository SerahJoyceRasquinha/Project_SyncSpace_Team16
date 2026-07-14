import { useEffect, useRef } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { MonacoBinding } from 'y-monaco';
import '../monaco-setup'; // must run before the editor mounts

/**
 * y-monaco does all the hard work: it binds a Y.Text to a Monaco
 * text model AND renders remote selections from the awareness object.
 */
export default function Editor({ ydoc, awareness }) {
  const bindingRef = useRef(null);

  useEffect(() => {
    return () => bindingRef.current?.destroy();
  }, []);

  const handleMount = (editor) => {
    const ytext = ydoc.getText('monaco');
    if (ytext.length === 0) {
      ytext.insert(0, '// SyncSpace live editor\n// Open this room in a second tab and type here.\n\nfunction hello(name) {\n  return `hi ${name}`;\n}\n');
    }
    bindingRef.current = new MonacoBinding(
      ytext,
      editor.getModel(),
      new Set([editor]),
      awareness
    );
  };

  return (
    <div className="pane">
      <div className="pane-header"><span>Code Editor</span></div>
      <MonacoEditor
        height="520px"
        defaultLanguage="javascript"
        theme="vs-dark"
        onMount={handleMount}
        options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true }}
      />
    </div>
  );
}
