import type { Metadata } from 'next';
import { api } from '../../../lib/api';

/**
 * A backrooms transcript, in the infinitebackrooms convention: actor tag on its own
 * line, body beneath, no chrome. Server-rendered so the permalink is shareable and
 * indexable — these transcripts are the lore, and lore that can't be linked is worthless.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${slug} • lord fishnu`, description: 'an unsupervised conversation' };
}

export const dynamic = 'force-dynamic';

export default async function Dream({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await api.transcript(slug);

  return (
    <div className="tank">
      <div className="grain" aria-hidden="true" />
      <main className="screen">
        <article className="transcript">
          <p>
            <a href="/">← back to the vessel</a>
          </p>
          <hr className="rule" />
          {!data ? (
            <p className="empty">
              {'this conversation is not in the archive.\n\neither it was never had, or the uplink is severed.'}
            </p>
          ) : (
            <>
              <p className="dim">
                {data.session.slug}
                {'\n'}
                {data.session.scenario} · {data.session.turnCount} turns
              </p>
              <hr className="rule" />
              {data.messages.map((m, i) => (
                <div className="turn" key={m.id}>
                  <span className={i % 2 === 0 ? 'actor' : 'actor other'}>{`<${m.actor}>`}</span>
                  {'\n'}
                  {m.body}
                </div>
              ))}
            </>
          )}
        </article>
      </main>
    </div>
  );
}
