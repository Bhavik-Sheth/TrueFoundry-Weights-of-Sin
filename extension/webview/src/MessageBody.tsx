import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { post } from './bridge';

function sourceReference(href: string) {
  const match = /^(?:\.\/)?([\w.-]+(?:\/[\w.-]+)*\.[\w-]+)(?:#L(\d+)(?:-L\d+)?|:(\d+))?$/.exec(href);
  if (!match || match[1].split('/').some(part => part === '..' || part === '.git')) return;
  const line = Number(match[2] ?? match[3] ?? 1);
  if (Number.isSafeInteger(line) && line > 0) return { path: match[1], line };
}

export function MessageBody({ text }: { text: string }) {
  return <div className="message-body">
    <Markdown
      skipHtml
      disallowedElements={['img']}
      remarkPlugins={[remarkGfm]}
      urlTransform={url => sourceReference(url) || /^https?:\/\//i.test(url) ? url : ''}
      components={{
        a: ({ href, children }) => {
          const source = href && sourceReference(href);
          if (source) return <button type="button" className="inline-action"
            onClick={() => post({ type: 'openSource', ...source })}>{children}</button>;
          return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>;
        },
        table: ({ children }) => <div className="message-table"><table>{children}</table></div>,
      }}
    >{text}</Markdown>
  </div>;
}
