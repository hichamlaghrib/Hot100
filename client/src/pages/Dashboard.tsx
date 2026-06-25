import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { Play, RefreshCw, Download, ChevronRight, Clock, CheckCircle2, AlertCircle, Loader2, TrendingUp, Users, Flame, Youtube, Music2, Instagram, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format } from "date-fns";
import type { Report } from "@shared/schema";

function StatusIcon({ status }: { status: string }) {
  if (status === "complete") return <CheckCircle2 size={14} className="text-green-500" />;
  if (status === "running") return <Loader2 size={14} className="text-primary animate-spin" />;
  if (status === "error") return <AlertCircle size={14} className="text-destructive" />;
  return <Clock size={14} className="text-muted-foreground" />;
}

type Platform = "youtube" | "tiktok" | "instagram";

const PLATFORMS: { id: Platform; label: string; Icon: any }[] = [
  { id: "youtube", label: "YouTube", Icon: Youtube },
  { id: "tiktok", label: "TikTok", Icon: Music2 },
  { id: "instagram", label: "Instagram", Icon: Instagram },
];

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
};

function PlatformBadge({ platform }: { platform?: string | null }) {
  const p = (platform ?? "youtube") as Platform;
  const meta = PLATFORMS.find(x => x.id === p) ?? PLATFORMS[0];
  const Icon = meta.Icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-secondary text-muted-foreground border-border">
      <Icon size={12} />
      {meta.label}
    </span>
  );
}

const PHASE_LABEL: Record<string, string> = {
  search: "Searching creators",
  trends: "Fetching trends",
  enrich: "Enriching profiles",
  ml: "Training ML models",
  scoring: "Scoring & ranking",
  done: "Complete",
};

function ProgressBar({ report }: { report: any }) {
  const progress = Math.max(0, Math.min(100, report.progress ?? 0));
  const phase = report.phase as string | undefined;
  // While running, errorMessage carries the live human-readable status label.
  const label = report.errorMessage || (phase ? PHASE_LABEL[phase] : "Starting...");
  return (
    <div className="mt-2 w-full" data-testid={`progress-${report.id}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground truncate pr-2">{label}</span>
        <span className="text-[11px] font-medium text-primary tabular-nums">{progress}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    complete: "bg-green-500/15 text-green-400 border-green-500/20",
    running: "bg-primary/15 text-primary border-primary/20",
    error: "bg-destructive/15 text-destructive border-destructive/20",
    pending: "bg-secondary text-muted-foreground border-border",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${variants[status] || variants.pending}`}>
      <StatusIcon status={status} />
      {status}
    </span>
  );
}

export default function Dashboard() {
  const { toast } = useToast();

  const { data: reports, isLoading } = useQuery<Report[]>({
    queryKey: ["/api/reports"],
    refetchInterval: (query) => {
      // Poll every 3s if any report is running
      const data = query.state?.data;
      if (Array.isArray(data) && data.some((r: any) => r.status === "running")) return 3000;
      return false;
    },
  });

  const [platform, setPlatform] = useState<Platform>("youtube");

  const runMutation = useMutation({
    mutationFn: async (p: Platform) => {
      const res = await apiRequest("POST", "/api/reports/run", { platform: p });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      toast({ title: "Weekly sync started", description: `Fetching ${PLATFORM_LABEL[platform]} creators from Tubular + Modash...` });
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (reportId: number) => {
      const res = await apiRequest("POST", `/api/reports/${reportId}/cancel`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      toast({ title: "Pipeline stopped", description: "The running report has been cancelled." });
    },
    onError: (err: any) => {
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" });
    },
  });

  const latestReport = reports?.[0];
  const completedReports = reports?.filter(r => r.status === "complete") ?? [];

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Flame size={20} className="text-primary" />
            Weekly Hot 100
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            US-based, English-language mid-sized creators (100k–1M) with spiking momentum
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Platform selector — one run per platform */}
          <div className="inline-flex rounded-md border border-border bg-card p-0.5" data-testid="platform-selector">
            {PLATFORMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                data-testid={`platform-${id}`}
                onClick={() => setPlatform(id)}
                disabled={runMutation.isPending}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                  platform === id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
          <Button
            data-testid="button-run-sync"
            onClick={() => runMutation.mutate(platform)}
            disabled={runMutation.isPending || latestReport?.status === "running"}
            size="sm"
            className="gap-2"
          >
            {(runMutation.isPending || latestReport?.status === "running")
              ? <><Loader2 size={14} className="animate-spin" /> Running...</>
              : <><Play size={14} /> Run This Week</>
            }
          </Button>
          {latestReport?.status === "running" && (
            <Button
              data-testid="button-cancel-sync"
              onClick={() => cancelMutation.mutate(latestReport.id)}
              disabled={cancelMutation.isPending}
              size="sm"
              variant="destructive"
              className="gap-2"
            >
              {cancelMutation.isPending
                ? <><Loader2 size={14} className="animate-spin" /> Stopping...</>
                : <><StopCircle size={14} /> Stop</>
              }
            </Button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      {latestReport?.status === "complete" && (
        <div className="grid grid-cols-3 gap-4">
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-primary/10">
                  <Users size={16} className="text-primary" />
                </div>
                <div>
                  <div className="text-xl font-bold">{latestReport.totalFound}</div>
                  <div className="text-xs text-muted-foreground">Creators ranked</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-accent/10">
                  <TrendingUp size={16} className="text-accent" />
                </div>
                <div>
                  <div className="text-xl font-bold">{latestReport.weekLabel}</div>
                  <div className="text-xs text-muted-foreground">Current week</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-md bg-green-500/10">
                  <CheckCircle2 size={16} className="text-green-500" />
                </div>
                <div>
                  <div className="text-xl font-bold">{completedReports.length}</div>
                  <div className="text-xs text-muted-foreground">Reports total</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Reports list */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Report History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : !reports?.length ? (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <Flame size={32} className="text-primary/40 mb-3" />
              <p className="text-sm font-medium text-foreground">No reports yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Configure your API keys in Settings, then run your first sync.
              </p>
              <div className="flex gap-3 mt-4">
                <Link href="/settings">
                  <Button variant="outline" size="sm">Go to Settings</Button>
                </Link>
                <Button
                  size="sm"
                  onClick={() => runMutation.mutate(platform)}
                  disabled={runMutation.isPending}
                >
                  <Play size={14} className="mr-1.5" /> Run Now
                </Button>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {reports.map(report => (
                <div
                  key={report.id}
                  data-testid={`row-report-${report.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <StatusBadge status={report.status} />
                    <PlatformBadge platform={(report as any).platform} />
                    <div>
                      <div className="text-sm font-medium">{report.weekLabel}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(report.generatedAt as any * 1000 || report.generatedAt), { addSuffix: true })}
                        {report.status === "complete" && ` · ${report.totalFound} creators`}
                        {report.status === "error" && ` · ${report.errorMessage}`}
                      </div>
                      {report.status === "running" && (
                        <div className="flex items-center gap-2">
                          <div className="w-72 max-w-[60vw]">
                            <ProgressBar report={report} />
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={(e) => { e.stopPropagation(); cancelMutation.mutate(report.id); }}
                            disabled={cancelMutation.isPending}
                            data-testid={`button-cancel-${report.id}`}
                          >
                            <StopCircle size={13} />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {report.status === "complete" && (
                      <>
                        <a
                          href={`/api/reports/${report.id}/export`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          data-testid={`link-export-${report.id}`}
                        >
                          <Download size={13} />
                          CSV
                        </a>
                        <Link href={`/report/${report.id}`}>
                          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" data-testid={`button-view-${report.id}`}>
                            View <ChevronRight size={13} />
                          </Button>
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
