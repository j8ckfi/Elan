// Assistant markdown rendering: GFM + syntax-highlighted code. Styled via the
// `.mari-md` block in index.css so react-markdown can emit plain tags.

import { useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import "highlight.js/styles/github-dark.css";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/copy-text";

// Code block with a hover-revealed copy control. The block's background is
// a theme token (`--secondary`, see index.css's `.mari-md pre`), not a fixed
// dark palette, so the button uses theme-relative colors too rather than
// fixed light-on-dark ones.
function Pre(props: ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    await copyText(text.replace(/\n$/, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="mari-pre group/pre relative">
      <pre ref={preRef} {...props} />
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        className={cn(
          "absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-md",
          "text-foreground/50 hover:bg-foreground/10 hover:text-foreground/90 active:scale-[0.96]",
          "transition-[color,background-color,opacity,transform] duration-100",
          "opacity-0 group-hover/pre:opacity-100 focus-visible:opacity-100",
          copied && "opacity-100 text-foreground/90",
        )}
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
    </div>
  );
}

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
        components={{ pre: Pre }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
