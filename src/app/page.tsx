import { getMenuIndex } from '@/domain/menu';
import { VoiceOrderApp } from '@/components/VoiceOrderApp';

/**
 * The catalogue is validated on the server and handed to the client as the
 * initial state, so the menu board paints on first render — no loading spinner,
 * and no chance of the browser showing a menu the server would not honour.
 */
export default function Page() {
  const { menu } = getMenuIndex();
  return <VoiceOrderApp menu={menu} />;
}
