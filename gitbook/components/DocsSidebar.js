"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_CONFIG } from "@/constants/docsConfig";
import { DEFAULT_LANG } from "@/constants/languages";
import { ChevronDown, ChevronRight, BookOpen, Rocket, Terminal, Monitor, FolderOpen, HelpCircle, MessageCircle, Layers, Plug, Cloud, Zap, Wallet, Gift, GitBranch, BarChart3, Code2, Sparkles, Server, Globe } from "lucide-react";

const SECTION_ICONS = {
  "Getting Started": Rocket,
  "Providers": Layers,
  "Features": Zap,
  "Integration": Plug,
  "Deployment": Cloud,
  "Help": HelpCircle
};

const ITEM_ICONS = {
  "Introduction": BookOpen,
  "Quick Start": Rocket,
  "Installation": Terminal,
  "Subscription (Maximize)": Sparkles,
  "Cheap (Backup)": Wallet,
  "Free (Fallback)": Gift,
  "Smart Routing": GitBranch,
  "Combos & Fallback": Layers,
  "Quota Tracking": BarChart3,
  "Claude Code": Code2,
  "OpenAI Codex": Code2,
  "Cursor": Code2,
  "Cline": Code2,
  "Roo": Code2,
  "Continue": Code2,
  "Other Tools": Plug,
  "Localhost": Monitor,
  "Cloud (VPS/Docker)": Server,
  "Troubleshooting": HelpCircle,
  "FAQ": MessageCircle
};

export default function DocsSidebar({ isMobile = false, onClose, lang = DEFAULT_LANG }) {
  const pathname = usePathname();
  const [openSections, setOpenSections] = useState(
    DOCS_CONFIG.navigation.map((_, i) => i)
  );

  const toggleSection = (index) => {
    setOpenSections(prev =>
      prev.includes(index)
        ? prev.filter(i => i !== index)
        : [...prev, index]
    );
  };

  // Build URL for a navigation slug under current language
  const buildHref = (slug) => (slug ? `/${lang}/${slug}` : `/${lang}`);

  const isActive = (slug) => pathname === buildHref(slug);

  const handleLinkClick = () => {
    if (isMobile && onClose) {
      onClose();
    }
  };

  return (
    <aside className={`${isMobile ? 'w-full' : 'w-64'} border-r bg-white border-gray-200 ${isMobile ? 'h-full' : 'h-[calc(100vh-4rem)] sticky top-16'} overflow-y-auto`}>
      <nav className="p-4 space-y-6">
        {DOCS_CONFIG.navigation.map((section, sectionIndex) => {
          const SectionIcon = SECTION_ICONS[section.title] || BookOpen;
          
          return (
            <div key={sectionIndex}>
              {/* Section title */}
              <button
                onClick={() => toggleSection(sectionIndex)}
                className="flex items-center justify-between w-full text-sm font-semibold text-gray-900 mb-2 hover:text-[#E68A6E] transition-colors"
              >
                <span className="flex items-center gap-2">
                  <SectionIcon className="w-4 h-4" />
                  {section.title}
                </span>
                {openSections.includes(sectionIndex) ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>

              {/* Section items */}
              {openSections.includes(sectionIndex) && (
                <ul className="space-y-1">
                  {section.items.map((item, itemIndex) => {
                    const ItemIcon = ITEM_ICONS[item.title] || BookOpen;
                    
                    return (
                      <li key={itemIndex}>
                        <Link
                          href={buildHref(item.slug)}
                          onClick={handleLinkClick}
                          className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                            isActive(item.slug)
                              ? "bg-[#E68A6E]/10 text-[#E68A6E] font-medium"
                              : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                          }`}
                        >
                          <ItemIcon className="w-4 h-4" />
                          {item.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
