export function BrandIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
    >
      <rect x="16" y="74" width="16" height="30" rx="8" fill="currentColor" opacity="0.45" />
      <rect x="42" y="56" width="16" height="48" rx="8" fill="currentColor" opacity="0.6" />
      <rect x="68" y="38" width="16" height="66" rx="8" fill="currentColor" opacity="0.8" />
      <rect x="94" y="18" width="16" height="86" rx="8" fill="#6366f1" />
    </svg>
  )
}
