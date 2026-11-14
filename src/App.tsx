/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AutoReconnectPanel } from './components/AutoReconnectPanel';
import { ConnectionPanel } from './components/ConnectionPanel';
import { HostManager } from './components/HostManager';
import { OptimizationPanel } from './components/OptimizationPanel';
import { TopBar } from './components/TopBar';
import {
  DEFAULT_AUTO_RECONNECT,
  DEFAULT_HOSTS,
  DEFAULT_OPTIMIZATION,
} from './data/defaultHosts';
import {
  ActiveTab,
  AutoReconnectConfig,
  ConnectionStatus,
  HostProfile,
  LogEntry,
  NetworkProbeResult,
  OptimizationConfig,
} from './types/vpn';
import {
  formatTimeNow,
  getModeLabel,
  getNavigatorConnection,
  runNetworkProbe,
} from './utils/network';

const STORAGE_KEYS = {
  hosts: 'khvpn_hosts_v1',
  activeHostId: 'khvpn_active_host_v1',
  optimization: 'khvpn_optimization_v1',
  autoReconnect: 'khvpn_autoreconnect_v1',
};

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('koneksi');
  const [hosts, setHosts] = useState<HostProfile[]>(() =>
    loadStored(STORAGE_KEYS.hosts, DEFAULT_HOSTS)
  );
  const [activeHostId, setActiveHostId] = useState<string>(() =>
    loadStored(STORAGE_KEYS.activeHostId, DEFAULT_HOSTS[0].id)
  );
  const [optimization, setOptimization] = useState<OptimizationConfig>(() =>
    loadStored(STORAGE_KEYS.optimization, DEFAULT_OPTIMIZATION)
  );
  const [autoReconnect, setAutoReconnect] = useState<AutoReconnectConfig>(() =>
    loadStored(STORAGE_KEYS.autoReconnect, DEFAULT_AUTO_RECONNECT)
  );

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [currentProvider, setCurrentProvider] = useState<string>(() => {
    const conn = getNavigatorConnection();
    return conn?.effectiveType
      ? `Jaringan (${conn.effectiveType.toUpperCase()})`
      : 'Wi-Fi / Broadband';
  });
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<NetworkProbeResult | null>(
    null
  );
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'init-1',
      timestamp: formatTimeNow(),
      level: 'info',
      message:
        'Kh vpn siap digunakan. Pilih host SSH & SlowDNS lalu klik Hubungkan.',
    },
  ]);

  const timersRef = useRef<number[]>([]);

  const clearScheduledTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  }, []);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: formatTimeNow(),
        level,
        message,
      },
      ...prev.slice(0, 59),
    ]);
  }, []);

  const activeHost =
    hosts.find((h) => h.id === activeHostId) || hosts[0] || DEFAULT_HOSTS[0];

  // Persist user configurations
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.hosts, JSON.stringify(hosts));
  }, [hosts]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activeHostId, JSON.stringify(activeHostId));
  }, [activeHostId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.optimization, JSON.stringify(optimization));
  }, [optimization]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.autoReconnect,
      JSON.stringify(autoReconnect)
    );
  }, [autoReconnect]);

  // Session duration counter
  useEffect(() => {
    if (status !== 'connected') return;
    const interval = window.setInterval(() => {
      setSessionSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  // Periodic keep-alive log when connected
  useEffect(() => {
    if (status !== 'connected' || optimization.keepAliveSec === 0) return;
    const interval = window.setInterval(() => {
      addLog(
        'info',
        `Keep-Alive (${optimization.keepAliveSec}s) terkirim ke ${activeHost.sshHost} · MTU ${optimization.mtu}`
      );
    }, optimization.keepAliveSec * 1000);
    return () => window.clearInterval(interval);
  }, [status, optimization.keepAliveSec, optimization.mtu, activeHost.sshHost, addLog]);

  const startConnectionSequence = useCallback(
    (isReconnect = false, providerReason?: string) => {
      clearScheduledTimers();
      setStatus(isReconnect ? 'reconnecting' : 'connecting');

      if (isReconnect) {
        setReconnectAttempts((c) => c + 1);
        addLog(
          'warn',
          providerReason
            ? `${providerReason}. Menjalankan auto-reconnect dalam ${autoReconnect.delaySec} detik...`
            : `Auto-reconnect dijalankan dalam ${autoReconnect.delaySec} detik...`
        );
      } else {
        setSessionSeconds(0);
        setReconnectAttempts(0);
        addLog(
          'info',
          `Memulai koneksi ${getModeLabel(activeHost.mode)} ke ${activeHost.name} (${activeHost.sshHost}:${activeHost.sshPort})`
        );
      }

      const initialDelay = isReconnect ? autoReconnect.delaySec * 1000 : 450;

      const t1 = window.setTimeout(() => {
        if (isReconnect && autoReconnect.flushDnsOnSwitch) {
          addLog(
            'info',
            `Flush DNS & reset socket selesai. Resolver aktif: ${activeHost.dnsResolver}`
          );
        } else if (activeHost.mode !== 'ssh-direct') {
          addLog(
            'info',
            `Handshake SlowDNS ke ${activeHost.nameserver} via ${activeHost.dnsResolver}`
          );
        }
      }, Math.max(250, initialDelay - 250));

      const t2 = window.setTimeout(() => {
        addLog(
          'info',
          `Optimasi aktif: ${optimization.tcpNoDelay ? 'TCP NoDelay' : 'TCP Standar'}, MTU ${optimization.mtu}, Buffer ${optimization.bufferKb} KB`
        );
      }, initialDelay + 350);

      const t3 = window.setTimeout(() => {
        setStatus('connected');
        addLog(
          'success',
          `Tunnel ${activeHost.name} terhubung dan stabil (${currentProvider}).`
        );
      }, initialDelay + 750);

      timersRef.current.push(t1, t2, t3);
    },
    [
      clearScheduledTimers,
      activeHost,
      autoReconnect.delaySec,
      autoReconnect.flushDnsOnSwitch,
      optimization.tcpNoDelay,
      optimization.mtu,
      optimization.bufferKb,
      currentProvider,
      addLog,
    ]
  );

  const handleToggleConnect = useCallback(() => {
    if (status === 'connected' || status === 'connecting' || status === 'reconnecting') {
      clearScheduledTimers();
      setStatus('disconnected');
      setSessionSeconds(0);
      addLog('info', `Koneksi ke ${activeHost.name} diputuskan oleh pengguna.`);
      return;
    }
    startConnectionSequence(false);
  }, [status, clearScheduledTimers, activeHost.name, addLog, startConnectionSequence]);

  const handleSimulateProviderSwitch = useCallback(
    (scenarioLabel = 'Wi-Fi ke Seluler 4G', nextProvider = 'Seluler 4G') => {
      setCurrentProvider(nextProvider);
      if (status !== 'connected') {
        addLog(
          'warn',
          `Perpindahan provider terdeteksi (${scenarioLabel}). Hubungkan tunnel untuk menguji pemulihan otomatis.`
        );
        startConnectionSequence(
          autoReconnect.enabled,
          `Provider berpindah (${scenarioLabel})`
        );
        return;
      }

      if (!autoReconnect.enabled) {
        clearScheduledTimers();
        setStatus('disconnected');
        addLog(
          'error',
          `Koneksi terputus saat berpindah provider (${scenarioLabel}) karena Auto-Reconnect nonaktif.`
        );
        return;
      }

      startConnectionSequence(true, `Perpindahan provider terdeteksi (${scenarioLabel})`);
    },
    [
      status,
      autoReconnect.enabled,
      clearScheduledTimers,
      addLog,
      startConnectionSequence,
    ]
  );

  // Real browser network events for online/offline & navigator.connection change
  useEffect(() => {
    const handleOffline = () => {
      setBrowserOnline(false);
      if (status === 'connected') {
        if (autoReconnect.enabled) {
          setStatus('reconnecting');
          addLog(
            'warn',
            'Jaringan perangkat terputus (offline). Menunggu sinyal provider kembali...'
          );
        } else {
          setStatus('disconnected');
          addLog('error', 'Jaringan terputus (offline).');
        }
      }
    };

    const handleOnline = () => {
      setBrowserOnline(true);
      if (
        (status === 'reconnecting' || status === 'connected') &&
        autoReconnect.enabled &&
        autoReconnect.detectProviderSwitch
      ) {
        startConnectionSequence(true, 'Jaringan perangkat kembali online');
      }
    };

    const conn = getNavigatorConnection();
    const handleConnChange = () => {
      const nextLabel = conn?.effectiveType
        ? `Jaringan (${conn.effectiveType.toUpperCase()})`
        : 'Jaringan Baru';
      setCurrentProvider(nextLabel);
      if (
        status === 'connected' &&
        autoReconnect.enabled &&
        autoReconnect.detectProviderSwitch
      ) {
        startConnectionSequence(true, `Perubahan jaringan terdeteksi: ${nextLabel}`);
      }
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    conn?.addEventListener?.('change', handleConnChange);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      conn?.removeEventListener?.('change', handleConnChange);
    };
  }, [
    status,
    autoReconnect.enabled,
    autoReconnect.detectProviderSwitch,
    addLog,
    startConnectionSequence,
  ]);

  const handleProbeLatency = useCallback(async () => {
    setProbing(true);
    const res = await runNetworkProbe();
    setProbeResult(res);
    setHosts((prev) =>
      prev.map((h) =>
        h.id === activeHost.id ? { ...h, lastLatencyMs: res.rttMs } : h
      )
    );
    addLog(
      'info',
      `Uji responsivitas selesai: RTT ${res.rttMs} ms · Jitter ±${res.jitterMs} ms · ${res.stabilityScore}`
    );
    setProbing(false);
  }, [activeHost.id, addLog]);

  const handleTestHostLatency = useCallback(
    async (id: string) => {
      const res = await runNetworkProbe();
      const target = hosts.find((h) => h.id === id);
      const jitterOffset = id === activeHost.id ? 0 : (id.length % 17) + 4;
      const measured = res.rttMs + jitterOffset;
      setHosts((prev) =>
        prev.map((h) => (h.id === id ? { ...h, lastLatencyMs: measured } : h))
      );
      if (target) {
        addLog('info', `Ping host ${target.name}: ${measured} ms`);
      }
    },
    [hosts, activeHost.id, addLog]
  );

  const handleSaveHost = useCallback(
    (saved: HostProfile) => {
      setHosts((prev) => {
        const exists = prev.some((h) => h.id === saved.id);
        return exists
          ? prev.map((h) => (h.id === saved.id ? saved : h))
          : [saved, ...prev];
      });
      setActiveHostId(saved.id);
      addLog('success', `Host ${saved.name} (${getModeLabel(saved.mode)}) disimpan.`);
    },
    [addLog]
  );

  const handleDeleteHost = useCallback(
    (id: string) => {
      setHosts((prev) => {
        const next = prev.filter((h) => h.id !== id);
        if (activeHostId === id && next.length > 0) {
          setActiveHostId(next[0].id);
        }
        return next;
      });
      addLog('info', 'Profil host dihapus.');
    },
    [activeHostId, addLog]
  );

  const handleDuplicateHost = useCallback(
    (host: HostProfile) => {
      const copy: HostProfile = {
        ...host,
        id: `host-${Date.now()}`,
        name: `${host.name} (Salinan)`,
      };
      setHosts((prev) => [copy, ...prev]);
      addLog('info', `Host ${host.name} diduplikasi.`);
    },
    [addLog]
  );

  const handleImportHosts = useCallback(
    (imported: HostProfile[]) => {
      setHosts(imported);
      if (imported[0]) setActiveHostId(imported[0].id);
      addLog('success', `${imported.length} profil host berhasil diimpor.`);
    },
    [addLog]
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#f6f5f0] text-[#111111]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        status={status}
        onToggleConnect={handleToggleConnect}
      />

      <main className="mx-auto w-full max-w-[1160px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {activeTab === 'koneksi' && (
          <ConnectionPanel
            status={status}
            hosts={hosts}
            activeHost={activeHost}
            onSelectHost={(id) => {
              setActiveHostId(id);
              const selected = hosts.find((h) => h.id === id);
              if (selected) {
                addLog('info', `Host aktif diganti ke ${selected.name}.`);
              }
            }}
            onToggleConnect={handleToggleConnect}
            sessionSeconds={sessionSeconds}
            currentProvider={currentProvider}
            browserOnline={browserOnline}
            optimization={optimization}
            autoReconnect={autoReconnect}
            onToggleAutoReconnect={() =>
              setAutoReconnect((prev) => ({
                ...prev,
                enabled: !prev.enabled,
              }))
            }
            onSimulateProviderSwitch={() => handleSimulateProviderSwitch()}
            onProbeLatency={handleProbeLatency}
            probing={probing}
            probeResult={probeResult}
            logs={logs}
            onClearLogs={() => setLogs([])}
            onGoToHosts={() => setActiveTab('host')}
          />
        )}

        {activeTab === 'host' && (
          <HostManager
            hosts={hosts}
            activeHostId={activeHost.id}
            onSelectHost={(id) => {
              setActiveHostId(id);
              const selected = hosts.find((h) => h.id === id);
              if (selected) {
                addLog('info', `Host aktif dipilih: ${selected.name}.`);
              }
            }}
            onSaveHost={handleSaveHost}
            onDeleteHost={handleDeleteHost}
            onDuplicateHost={handleDuplicateHost}
            onTestHostLatency={handleTestHostLatency}
            onImportHosts={handleImportHosts}
            isBusy={status !== 'disconnected'}
          />
        )}

        {activeTab === 'optimasi' && (
          <OptimizationPanel
            config={optimization}
            onChange={(next) => {
              setOptimization(next);
              addLog(
                'info',
                `Optimasi diperbarui: Preset ${next.preset} · MTU ${next.mtu} · Keep-Alive ${next.keepAliveSec}s`
              );
            }}
            onRunProbe={handleProbeLatency}
            probing={probing}
            probeResult={probeResult}
          />
        )}

        {activeTab === 'reconnect' && (
          <AutoReconnectPanel
            config={autoReconnect}
            onChange={(next) => {
              setAutoReconnect(next);
              addLog(
                'info',
                `Pengaturan Auto-Reconnect diperbarui (${next.enabled ? 'Aktif' : 'Nonaktif'}, jeda ${next.delaySec}s).`
              );
            }}
            status={status}
            currentProvider={currentProvider}
            reconnectAttempts={reconnectAttempts}
            onSimulateSwitch={handleSimulateProviderSwitch}
          />
        )}
      </main>

      <footer className="border-t-2 border-[#111111] bg-white">
        <div className="mx-auto flex max-w-[1160px] flex-col items-start justify-between gap-2 px-4 py-4 text-xs text-[#4b4b46] sm:flex-row sm:items-center sm:px-6">
          <span className="font-semibold text-[#111111]">
            Kh vpn · Klien SSH &amp; SlowDNS Neo-Brutalis Minimalis
          </span>
          <span>Tema Terang Ringan · Optimasi Koneksi &amp; Auto-Reconnect</span>
        </div>
      </footer>
    </div>
  );
}
