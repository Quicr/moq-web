interface AvatarProps {
  src?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = { sm: 'w-8 h-8 text-xs', md: 'w-10 h-10 text-sm', lg: 'w-14 h-14 text-lg' };

export function Avatar({ src, name, size = 'md' }: AvatarProps) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const colorIndex = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 6;
  const colors = [
    'bg-purple-400', 'bg-blue-400', 'bg-emerald-400',
    'bg-amber-400', 'bg-rose-400', 'bg-cyan-400',
  ];

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${sizes[size]} rounded-full object-cover ring-2 ring-white/50`}
      />
    );
  }

  return (
    <div
      className={`${sizes[size]} ${colors[colorIndex]} rounded-full flex items-center justify-center text-white font-semibold ring-2 ring-white/50`}
    >
      {initials}
    </div>
  );
}
