import gsap from "gsap";
import { useEffect, useRef } from "react";

interface KatBracketsLogoProps {
  readonly size?: number;
  readonly scanning?: boolean;
  readonly decorative?: boolean;
}

/**
 * Marca oficial Kat-Brackets de LintFixer.
 * Excecao justificada da Vacina dos 7 Erros: identidade geometrica animada
 * com chaves `{ }` reativas ao pipeline em tempo real e olhos em cursor `_ _`.
 */
export function KatBracketsLogo({
  size = 28,
  scanning = false,
  decorative = false,
}: KatBracketsLogoProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = gsap.context(() => {
      const leftBracket = el.querySelector(".kb-left");
      const rightBracket = el.querySelector(".kb-right");
      const eyes = el.querySelectorAll(".kb-eye");

      if (scanning) {
        gsap.to(leftBracket, {
          x: -2.5,
          duration: 0.28,
          repeat: -1,
          yoyo: true,
          ease: "power1.inOut",
        });
        gsap.to(rightBracket, {
          x: 2.5,
          duration: 0.28,
          repeat: -1,
          yoyo: true,
          ease: "power1.inOut",
        });
      }

      gsap.to(eyes, {
        scaleY: 0.25,
        transformOrigin: "center center",
        duration: 0.11,
        repeat: -1,
        repeatDelay: 3.6,
        yoyo: true,
        ease: "power2.inOut",
      });
    }, el);

    return () => ctx.revert();
  }, [scanning]);

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : "Kat-Brackets"}
    >
      <path
        d="M24 22 L46 42 H82 L104 22 L108 62 C108 92 90 108 64 108 C38 108 20 92 20 62 Z"
        fill="#ECEFF4"
        stroke="#ECEFF4"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M27 28 L44 44 L31 54 Z" fill="#090B0E" />
      <path d="M101 28 L84 44 L97 54 Z" fill="#090B0E" />
      <path
        className="kb-left"
        d="M16 48 C10 48 10 58 6 62 C10 66 10 76 16 76"
        stroke="#ECEFF4"
        strokeWidth="5.5"
        strokeLinecap="round"
      />
      <path
        className="kb-right"
        d="M112 48 C118 48 118 58 122 62 C118 66 118 76 112 76"
        stroke="#ECEFF4"
        strokeWidth="5.5"
        strokeLinecap="round"
      />
      <rect className="kb-eye" x="41" y="64" width="15" height="6.5" rx="2" fill="#090B0E" />
      <rect className="kb-eye" x="72" y="64" width="15" height="6.5" rx="2" fill="#090B0E" />
      <polygon points="64,78 58,72 70,72" fill="#090B0E" />
      <path
        d="M56 85 Q64 91 72 85"
        stroke="#090B0E"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
