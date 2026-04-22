"use client";

import { useEffect } from "react";
import { initAnalytics, trackEvent } from "~/lib/analytics";

export default function MixpanelInit() {
  useEffect(() => {
    initAnalytics();
    trackEvent("App Loaded");
  }, []);

  return null;
}
