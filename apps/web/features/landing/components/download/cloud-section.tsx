"use client";

import { useLocale } from "../../i18n";

/**
 * Cloud runtime section on the download page. The cloud-waitlist form that
 * lived in the onboarding package was removed with the onboarding flow; this
 * section now renders the heading + copy only.
 *
 * THROWAWAY POC: the cloud waitlist was an onboarding-adjacent feature; it was
 * deleted alongside the onboarding removal. NEVER MERGE.
 */
export function CloudSection() {
  const { t } = useLocale();
  const d = t.download.cloud;

  return (
    <section className="bg-white py-20 text-[#0a0d12] sm:py-24">
      <div className="mx-auto max-w-[720px] px-4 sm:px-6 lg:px-8">
        <h2 className="font-[family-name:var(--font-serif)] text-[2.2rem] leading-[1.1] tracking-[-0.03em] sm:text-[2.6rem]">
          {d.title}
        </h2>
        <p className="mt-4 max-w-[560px] text-[15px] leading-7 text-[#0a0d12]/72">
          {d.sub}
        </p>
      </div>
    </section>
  );
}