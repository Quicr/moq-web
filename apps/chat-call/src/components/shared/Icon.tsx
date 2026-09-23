interface IconProps {
  name: string;
  className?: string;
  size?: number;
}

export function Icon({ name, className = '', size = 24 }: IconProps) {
  return (
    <span
      className={`material-icon select-none ${className}`}
      style={{ fontSize: size }}
    >
      {name}
    </span>
  );
}
