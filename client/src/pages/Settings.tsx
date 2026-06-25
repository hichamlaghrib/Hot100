import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Save, Key, SlidersHorizontal, Info, CheckCircle2, Globe, Zap } from "lucide-react";

function SecretInput({ value, onChange, placeholder, testId, isSet }: {
  value: string; onChange: (v: string) => void; placeholder: string; testId: string; isSet?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        data-testid={testId}
        type={show ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={isSet ? "Key is set — paste a new one to update" : placeholder}
        className="pr-16 text-sm font-mono"
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
        {isSet && <CheckCircle2 size={13} className="text-green-500" />}
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

export default function Settings() {
  const { toast } = useToast();

  const { data: config } = useQuery<Record<string, string>>({
    queryKey: ["/api/config"],
  });

  const [form, setForm] = useState({
    tubularApiKey: "",
    modashApiKey: "",
    minFollowers: "100000",
    maxFollowers: "1000000",
    minFollowersGrowth: "0.03",
    minEngagementRate: "2",
    minUploads30d: "2",
    targetCount: "100",
  });

  useEffect(() => {
    if (config) {
      setForm(f => ({
        tubularApiKey: f.tubularApiKey,
        modashApiKey: f.modashApiKey,
        minFollowers: config.minFollowers || f.minFollowers,
        maxFollowers: config.maxFollowers || f.maxFollowers,
        minFollowersGrowth: config.minFollowersGrowth || f.minFollowersGrowth,
        minEngagementRate: config.minEngagementRate || f.minEngagementRate,
        minUploads30d: config.minUploads30d || f.minUploads30d,
        targetCount: config.targetCount || f.targetCount,
      }));
    }
  }, [config]);

  const tubularSet = config?.tubularKeySet === "true";
  const modashSet  = config?.modashKeySet  === "true";

  const mutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await apiRequest("POST", "/api/config", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      toast({ title: "Settings saved" });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure API credentials and discovery filters.
        </p>
      </div>

      {/* API Keys */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Key size={15} className="text-primary" />
            API Credentials
          </CardTitle>
          <CardDescription className="text-xs">
            Stored in your local SQLite database. Never transmitted anywhere except the respective APIs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium flex items-center gap-2 mb-2">
              Tubular Labs API Key
              {tubularSet && <span className="text-xs text-green-500 font-normal flex items-center gap-1"><CheckCircle2 size={11} />Active</span>}
            </label>
            <SecretInput
              testId="input-tubular-key"
              value={form.tubularApiKey}
              onChange={v => setForm(f => ({ ...f, tubularApiKey: v }))}
              placeholder="80562-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              isSet={tubularSet}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Auth header: <code className="bg-secondary px-1 rounded text-xs">api-key: &lt;key&gt;</code> — used for <code className="bg-secondary px-1 rounded text-xs">creator.search</code> + <code className="bg-secondary px-1 rounded text-xs">creator.trends</code>
            </p>
          </div>
          <Separator />
          <div>
            <label className="text-sm font-medium flex items-center gap-2 mb-2">
              Modash API Key
              {modashSet && <span className="text-xs text-green-500 font-normal flex items-center gap-1"><CheckCircle2 size={11} />Active</span>}
            </label>
            <SecretInput
              testId="input-modash-key"
              value={form.modashApiKey}
              onChange={v => setForm(f => ({ ...f, modashApiKey: v }))}
              placeholder="U98fv2ftxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              isSet={modashSet}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Auth header: <code className="bg-secondary px-1 rounded text-xs">Authorization: Bearer &lt;key&gt;</code> — enriches engagement rate, audience, credibility, and contact data.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Discovery Filters */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-accent" />
            Discovery Filters
          </CardTitle>
          <CardDescription className="text-xs">
            Creators must pass all thresholds before entering the scoring pipeline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* Locked US filter badge */}
          <div className="flex items-center gap-2 p-2.5 rounded-md bg-blue-500/10 border border-blue-500/20">
            <Globe size={13} className="text-blue-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-blue-300">Country Filter</span>
              <span className="text-xs text-muted-foreground ml-2">US-based creators only — applied at Tubular API level</span>
            </div>
            <Badge variant="secondary" className="text-xs bg-blue-500/20 text-blue-300 border-blue-500/30 shrink-0">
              🇺🇸 US Only
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium block mb-2">Min. Subscribers</label>
              <Input data-testid="input-min-followers" type="number" value={form.minFollowers} onChange={e => setForm(f => ({ ...f, minFollowers: e.target.value }))} className="text-sm" />
              <p className="text-xs text-muted-foreground mt-1">Default: 100,000</p>
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">Max. Subscribers</label>
              <Input data-testid="input-max-followers" type="number" value={form.maxFollowers} onChange={e => setForm(f => ({ ...f, maxFollowers: e.target.value }))} className="text-sm" />
              <p className="text-xs text-muted-foreground mt-1">Default: 1,000,000</p>
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">Min. Followers Growth (30d)</label>
              <Input data-testid="input-min-growth" type="number" step="0.01" value={form.minFollowersGrowth} onChange={e => setForm(f => ({ ...f, minFollowersGrowth: e.target.value }))} className="text-sm" />
              <p className="text-xs text-muted-foreground mt-1">0.03 = 3% growth in 30d</p>
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">Min. Engagement Rate (%)</label>
              <Input data-testid="input-min-engagement" type="number" step="0.1" value={form.minEngagementRate} onChange={e => setForm(f => ({ ...f, minEngagementRate: e.target.value }))} className="text-sm" />
              <p className="text-xs text-muted-foreground mt-1">2 = 2% minimum (Modash filter)</p>
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">Min. Uploads (last 30d)</label>
              <Input data-testid="input-min-uploads" type="number" value={form.minUploads30d} onChange={e => setForm(f => ({ ...f, minUploads30d: e.target.value }))} className="text-sm" />
              <p className="text-xs text-muted-foreground mt-1">2 = at least 2 videos in 30 days</p>
            </div>
            <div>
              <label className="text-sm font-medium block mb-2">Target List Size</label>
              <Input data-testid="input-target-count" type="number" value={form.targetCount} onChange={e => setForm(f => ({ ...f, targetCount: e.target.value }))} className="text-sm" />
              <p className="text-xs text-muted-foreground mt-1">Max creators to rank (default: 100)</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Scoring formula — updated to 5-signal model */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap size={15} className="text-accent" />
            Hot Score Formula
            <Badge variant="secondary" className="text-xs ml-auto">5-Signal Model</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 text-sm">
            {[
              { label: "WoW View Acceleration", weight: "35%", desc: "Last 2 wks vs prior 2 wks (Tubular creator.trends)", color: "text-primary" },
              { label: "YoY Views Growth", weight: "20%", desc: "Year-over-year monthly view growth (Tubular)", color: "text-amber-400" },
              { label: "Engagement Rate", weight: "20%", desc: "From Modash profile report (fallback: Tubular TCR)", color: "text-green-400" },
              { label: "Followers Growth 30d", weight: "15%", desc: "Tubular performance.followers_growth", color: "text-blue-400" },
              { label: "Audience Quality", weight: "10%", desc: "1 − fake follower score (Modash credibility)", color: "text-purple-400" },
            ].map(row => (
              <div key={row.label} className="flex items-start gap-3 p-2.5 rounded-md bg-secondary/40">
                <div className={`${row.color} font-bold text-xs mt-0.5 w-8 shrink-0`}>{row.weight}</div>
                <div>
                  <div className="font-medium text-xs">{row.label}</div>
                  <div className="text-xs text-muted-foreground">{row.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="p-2.5 rounded-md bg-primary/10 border border-primary/20 text-xs text-muted-foreground">
            <span className="text-primary font-semibold">× 1.15 bonus</span> applied when Tubular flags a creator as <code className="bg-secondary px-1 rounded">rising_star = true</code>. Final score capped at 100.
          </div>
        </CardContent>
      </Card>

      <Button data-testid="button-save-settings" onClick={() => mutation.mutate(form)} disabled={mutation.isPending} className="gap-2">
        <Save size={14} />
        {mutation.isPending ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
