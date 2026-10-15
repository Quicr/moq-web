import { DraftSwitch, ThemeSwitch, useTransportConfig } from '@moq-web/app-kit';
import { SettingsButtons } from './ChatSettingsDialog';

export function TopBar() {
  const cfg = useTransportConfig();

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
      className="ak-glass"
    >
      <span className="ak-caption">chat + call</span>
      <span className="ak-chip ak-chip-neutral">{cfg.profile}</span>
      <span className="ak-chip ak-chip-neutral">{cfg.publisher.deliveryMode}</span>
      <div style={{ flex: 1 }} />
      <DraftSwitch />
      <ThemeSwitch />
      <SettingsButtons />
    </header>
  );
}
