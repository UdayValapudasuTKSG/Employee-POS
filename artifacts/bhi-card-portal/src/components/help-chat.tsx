import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAskAssistant } from '@workspace/api-client-react';
import { IconTile } from '@/components/screen-ui';

interface ChatMessage {
  from: 'user' | 'bot';
  text: string;
}

const QUICK_QUESTIONS = [
  "How do I get my card?",
  "I didn't receive a code",
  "My contact details changed",
  "How long is my card visible?",
];

export function HelpChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      from: 'bot',
      text: "Hi! I'm the BHI helper. I can answer general questions about using this portal — I never look up personal or member information. What can I help with?",
    },
  ]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const ask = useAskAssistant();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, ask.isPending]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    setMessages((m) => [...m, { from: 'user', text: trimmed }]);
    setInput('');
    ask.mutate(
      { data: { message: trimmed.slice(0, 500) } },
      {
        onSuccess: (res) => {
          setMessages((m) => [...m, { from: 'bot', text: res.reply }]);
        },
        onError: () => {
          setMessages((m) => [
            ...m,
            {
              from: 'bot',
              text: "Sorry, something went wrong on my end. Please try again, or contact your company's HR department for help.",
            },
          ]);
        },
      },
    );
  };

  return (
    <section aria-labelledby="help-title" className="ds-card flex min-w-0 flex-col p-5 sm:p-6">
      <div className="mb-4 flex items-center gap-3">
        <IconTile icon={MessageCircle} size={40} />
        <div className="flex min-w-0 flex-col">
          <h2 id="help-title" className="ds-panel-title">Need help?</h2>
          <span className="ds-meta">Ask the BHI helper a general question</span>
        </div>
      </div>

      <div ref={scrollRef} className="mb-4 max-h-72 space-y-3 overflow-y-auto rounded-2xl bg-[var(--surface-2)] p-3 pr-2" aria-live="polite" data-testid="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={
                m.from === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[14.5px] leading-relaxed text-primary-foreground'
                  : 'max-w-[85%] rounded-2xl rounded-bl-md border border-[var(--surface-border-soft)] bg-[var(--surface-1)] px-4 py-2.5 text-[14.5px] leading-relaxed text-[var(--fg-1)]'
              }
              data-testid={`chat-message-${m.from}-${i}`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {ask.isPending && (
          <div className="flex justify-start">
            <div role="status" className="rounded-2xl rounded-bl-md bg-[var(--surface-1)] px-4 py-2.5 text-sm text-[var(--fg-3)]" data-testid="chat-typing">
              <span className="animate-pulse">typing…</span>
            </div>
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {QUICK_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => send(q)}
            className="press focus-ring min-h-11 rounded-full border border-[var(--surface-border)] bg-[var(--surface-1)] px-3.5 text-[13.5px] font-semibold text-[var(--brand-600)] hover:border-[var(--brand-200)] hover:bg-[var(--brand-50)]"
            data-testid={`chip-${q.slice(0, 12)}`}
          >
            {q}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={500}
          placeholder="Type your question…"
          aria-label="Your question"
          data-testid="input-chat"
        />
        <Button type="submit" size="icon" className="h-11 w-11 flex-shrink-0" disabled={!input.trim() || ask.isPending} aria-label="Send" data-testid="button-send-chat">
          <Send className="h-4 w-4" />
        </Button>
      </form>
      <p className="mt-3 text-[13px] leading-relaxed text-[var(--fg-3)]">
        This assistant answers general questions only and never accesses member data. For account-specific help, contact your HR department.
      </p>
    </section>
  );
}
