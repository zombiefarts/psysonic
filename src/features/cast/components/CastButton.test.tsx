import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { CastRenderer } from '@/lib/api/cast';

vi.mock('@/lib/api/cast', () => ({
  castListRenderers: vi.fn(),
}));

import { castListRenderers } from '@/lib/api/cast';
import { CastButton } from '@/features/cast/components/CastButton';
import { registerCastController, useCastStore } from '@/features/cast/store/castStore';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const renderer = (over: Partial<CastRenderer> = {}): CastRenderer => ({
  id: 'uuid:1',
  name: 'Living Room',
  manufacturer: 'EVERSOLO',
  model: 'AV Renderer Device',
  location: 'http://192.168.1.50:1670/description.xml',
  avControlUrl: 'http://192.168.1.50:1670/AVTransport/control.xml',
  avServiceType: 'urn:schemas-upnp-org:service:AVTransport:1',
  rcControlUrl: null,
  rcServiceType: null,
  ...over,
});

describe('CastButton', () => {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    useCastStore.setState({ renderers: [], discovering: false, discoverError: null, session: null });
    registerCastController({ start, stop });
  });

  it('lists discovered devices and starts a session on the chosen one', async () => {
    vi.mocked(castListRenderers).mockResolvedValue([renderer(), renderer({ id: 'uuid:2', name: 'Kitchen' })]);
    renderWithProviders(<CastButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Cast to device' }));
    expect(await screen.findByRole('menuitemradio', { name: /Living Room/ })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Kitchen/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Kitchen/ }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'uuid:2' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('says so when no device answers', async () => {
    vi.mocked(castListRenderers).mockResolvedValue([]);
    renderWithProviders(<CastButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Cast to device' }));
    expect(await screen.findByText(/No DLNA devices found/)).toBeTruthy();
  });

  it('shows a discovery error', async () => {
    vi.mocked(castListRenderers).mockRejectedValue(new Error('socket blocked'));
    renderWithProviders(<CastButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Cast to device' }));
    expect(await screen.findByText('socket blocked')).toBeTruthy();
  });

  it('names the active renderer and offers to stop casting', async () => {
    vi.mocked(castListRenderers).mockResolvedValue([renderer()]);
    useCastStore.setState({ session: { renderer: renderer(), status: null, error: null } });
    renderWithProviders(<CastButton />);

    const btn = screen.getByRole('button', { name: 'Casting to Living Room' });
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop casting' }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});
