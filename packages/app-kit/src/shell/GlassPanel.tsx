// SPDX-FileCopyrightText: Copyright (c) 2025 Cisco Systems
// SPDX-License-Identifier: BSD-2-Clause

import React from 'react';

export interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  strong?: boolean;
  padding?: 'sm' | 'md' | 'lg';
}

export const GlassPanel = React.forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  { strong, padding = 'md', className = '', style, children, ...rest },
  ref,
) {
  const glass = strong ? 'ak-glass-strong' : 'ak-glass';
  const pad = padding === 'sm' ? { padding: 14 } : padding === 'lg' ? { padding: 28 } : { padding: 20 };
  return (
    <div ref={ref} className={`${glass} ${className}`.trim()} style={{ ...pad, ...style }} {...rest}>
      {children}
    </div>
  );
});
