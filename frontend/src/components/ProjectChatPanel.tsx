import { type FormEvent, useEffect, useState } from 'react';
import { askProjectChat, getProjectChat, type ProjectChatMessage } from '../services/project-api';

export function ProjectChatPanel({ projectId }: { projectId: string }) {
  const [messages, setMessages] = useState<ProjectChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingHistory(true);
    setError(null);
    void getProjectChat(projectId)
      .then((result) => { if (active) setMessages(result.messages); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load project chat'); })
      .finally(() => { if (active) setLoadingHistory(false); });
    return () => { active = false; };
  }, [projectId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = question.trim();
    if (!submitted || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await askProjectChat(projectId, submitted);
      const createdAt = result.createdAt;
      setMessages((current) => [...current,
        { id: result.userMessageId, role: 'user' as const, content: submitted, citations: [], createdAt },
        { id: result.assistantMessageId, role: 'assistant' as const, content: result.answer, citations: result.citations, createdAt },
      ].slice(-100));
      setQuestion('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to answer this question');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="project-chat" aria-label="Ask about this project">
      <div className="project-chat__heading">
        <div><p className="micro-label">Project knowledge</p><h3>Ask about this project</h3></div>
        <span className="project-chat__scope">Retrieved sources only</span>
      </div>
      <div className="project-chat__messages" aria-live="polite">
        {loadingHistory ? <p className="muted">Loading project conversation...</p> : null}
        {!loadingHistory && messages.length === 0 ? <p className="muted">Ask about the website, repository, project fields, or latest saved case study. Answers use retrieved project evidence.</p> : null}
        {messages.map((message) => <article className={`project-chat__message project-chat__message--${message.role}`} key={message.id}>
          <span className="micro-label">{message.role === 'assistant' ? 'Project assistant' : 'You'}</span>
          <p>{message.content}</p>
          {message.role === 'assistant' && message.citations.length > 0 ? <ul className="project-chat__citations" aria-label="Retrieved sources">
            {message.citations.map((citation) => <li key={`${message.id}-${citation.id}`}>
              {citation.url ? <a href={citation.url} target="_blank" rel="noreferrer">{citation.title}</a> : <span>{citation.title}</span>}
              <small>{citation.sourceType.replace(/_/g, ' ')}</small>
            </li>)}
          </ul> : null}
        </article>)}
      </div>
      <form className="project-chat__form" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor={`project-chat-question-${projectId}`}>Question</label>
        <textarea id={`project-chat-question-${projectId}`} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} rows={3} placeholder="Ask about the architecture, features, risks, or report..." required />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="btn btn--primary" type="submit" disabled={sending || !question.trim()}>{sending ? 'Searching project knowledge...' : 'Ask project assistant'}</button>
      </form>
    </section>
  );
}
