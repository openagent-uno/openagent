import { useMemo } from 'react';
import type { ProjectPreviewFrame } from '../services/api';

export default function ProjectPreview({ frame }: { frame: ProjectPreviewFrame }) {
  const html = useMemo(() => {
    if (frame.mime !== 'text/html') return '';
    const bytes = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0));
    const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
    return '<meta http-equiv="Content-Security-Policy" content="' + policy + '">' + new TextDecoder().decode(bytes);
  }, [frame]);
  if (frame.mime === 'image/png') return <img alt="Project preview" src={'data:image/png;base64,' + frame.data}
    style={{objectFit:'contain',maxWidth:'100%',maxHeight:420}} />;
  return <iframe title="Project preview" sandbox="" referrerPolicy="no-referrer" srcDoc={html}
    style={{width:'100%',height:360,border:0,background:'white'}} />;
}
