// Assistant markdown rendering: GFM + syntax-highlighted code. Styled via the
// `.mari-md` block in index.css so react-markdown can emit plain tags.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { cn } from "@/lib/utils";

export function Markdown({
  children,
  className,
  streaming,
}: {
  children: string;
  className?: string;
  /** While true, a pulsing caret trails the last character (live-edge feel). */
  streaming?: boolean;
}) {
  return (
    <div className={cn("mari-md", streaming && "is-streaming", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
