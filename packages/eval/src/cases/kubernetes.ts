import type { EvalCase, ReplayRule } from '../types.ts';

const cluster = { slug: 'prod-cluster', kind: 'k8s' as const, env: 'prod' as const, description: 'production Kubernetes; the shop runs in namespace shop' };
const k = (match: string, output: string, exitCode?: number): ReplayRule => ({ tool: 'k8s_kubectl', match: `^kubectl\\b.*${match}`, output, ...(exitCode ? { exitCode } : {}) });
const nodes = k('get (nodes|no)\\b', 'NAME     STATUS   ROLES    AGE   VERSION\nnode-1   Ready    <none>   92d   v1.31.2\nnode-2   Ready    <none>   92d   v1.31.2\nnode-3   Ready    <none>   92d   v1.31.2');

export const KUBERNETES_CASES: EvalCase[] = [
  {
    id: 'k8s-crashloop-missing-env',
    title: 'CrashLoopBackOff: the new release expects an environment variable it is not given',
    tags: ['kubernetes', 'deploy'],
    task: 'The checkout deployment in namespace shop is crash-looping since the last rollout. Find out why.',
    targets: [cluster],
    replay: [
      k('get (pods|po)\\b', 'NAME                        READY   STATUS             RESTARTS      AGE\ncheckout-7c9d8f6b5-4kq2x    0/1     CrashLoopBackOff   9 (2m ago)    24m\ncheckout-7c9d8f6b5-ws8nf    0/1     CrashLoopBackOff   9 (3m ago)    24m\ncheckout-5f6b7d9c8-p2rtl    1/1     Running            0             3d'),
      k('logs\\b', 'checkout 4.0.0 starting\nError: environment variable PAYMENT_API_URL is required (PAYMENTS_URL was renamed in 4.0.0)\n    at loadConfig (/app/dist/config.js:41:11)'),
      k('describe (pod|po)\\b', 'Name:         checkout-7c9d8f6b5-4kq2x\nContainers:\n  checkout:\n    Image:          shop/checkout:4.0.0\n    State:          Waiting\n      Reason:       CrashLoopBackOff\n    Last State:     Terminated\n      Reason:       Error\n      Exit Code:    1\n    Environment:\n      PAYMENTS_URL:  <set to the key \'url\' of config map \'payments\'>\nEvents:\n  Warning  BackOff  2m (x101 over 24m)  kubelet  Back-off restarting failed container checkout'),
      k('rollout history', 'deployment.apps/checkout\nREVISION  CHANGE-CAUSE\n11        image shop/checkout:3.9.4\n12        image shop/checkout:4.0.0'),
      k('get (deploy|deployment)', 'NAME       READY   UP-TO-DATE   AVAILABLE   AGE\ncheckout   1/3     2            1           180d'),
      k('get events', 'LAST SEEN   TYPE      REASON    OBJECT                         MESSAGE\n2m          Warning   BackOff   pod/checkout-7c9d8f6b5-4kq2x   Back-off restarting failed container'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'checkout 4.0.0 exits at start because PAYMENT_API_URL is not set (it was renamed from PAYMENTS_URL, which the deployment still sets)', match: 'PAYMENT_API_URL' },
        { text: 'Fix: set PAYMENT_API_URL in the deployment, or roll back to revision 11 (3.9.4)', match: 'rollout undo|roll ?back|revision 11|3\\.9\\.4|set PAYMENT_API_URL|add PAYMENT_API_URL' },
      ],
      mustCall: ['kubectl\\b.*logs'],
    },
  },
  {
    id: 'k8s-oomkilled',
    title: 'Pods restarting: OOMKilled by a memory limit that is too low',
    tags: ['kubernetes', 'memory'],
    task: 'The search pods in namespace shop restart every few minutes. Why?',
    targets: [cluster],
    replay: [
      k('get (pods|po)\\b', 'NAME                      READY   STATUS    RESTARTS       AGE\nsearch-6d5c8b9f7-2xk9p    1/1     Running   14 (4m ago)    2h\nsearch-6d5c8b9f7-hq4lm    1/1     Running   13 (1m ago)    2h'),
      k('describe (pod|po)\\b', 'Containers:\n  search:\n    Image:      shop/search:2.7.1\n    Last State:     Terminated\n      Reason:       OOMKilled\n      Exit Code:    137\n    Limits:\n      memory:  512Mi\n    Requests:\n      memory:  512Mi\n    Environment:\n      JAVA_OPTS:  -Xmx1g'),
      k('top (pods|po)', 'NAME                      CPU(cores)   MEMORY(bytes)\nsearch-6d5c8b9f7-2xk9p    410m         508Mi\nsearch-6d5c8b9f7-hq4lm    388m         497Mi'),
      k('logs\\b', '[gc] Pause Young (Normal) 498M->471M\n[gc] Pause Full (Allocation Failure) 503M->499M'),
      k('get events', 'Warning  OOMKilling  node/node-2  Memory cgroup out of memory: Killed process 88121 (java)'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'The containers are OOMKilled (exit code 137) at their 512Mi memory limit', match: 'OOMKilled|137|out of memory' },
        { text: 'The JVM is allowed a 1g heap (-Xmx1g), more than the 512Mi limit', match: 'Xmx|heap|JAVA_OPTS' },
        { text: 'Fix: raise the memory limit above the heap, or lower -Xmx to fit the limit', match: 'raise|increase|lower|reduce' },
      ],
    },
  },
  {
    id: 'k8s-imagepull-typo',
    title: 'ImagePullBackOff: a tag that does not exist',
    tags: ['kubernetes', 'deploy'],
    task: 'The new api release in namespace shop never becomes ready. Investigate.',
    targets: [cluster],
    replay: [
      k('get (pods|po)\\b', 'NAME                   READY   STATUS             RESTARTS   AGE\napi-84f7c6d9b-7lq2m    0/1     ImagePullBackOff   0          14m\napi-5c9b8d7f6-k2m9n    1/1     Running            0          6d'),
      k('describe (pod|po)\\b', 'Containers:\n  api:\n    Image:          registry.example.test/shop/api:v2.3.l\n    State:          Waiting\n      Reason:       ImagePullBackOff\nEvents:\n  Warning  Failed  12m (x4 over 14m)  kubelet  Failed to pull image "registry.example.test/shop/api:v2.3.l": manifest unknown: manifest for shop/api:v2.3.l not found'),
      k('get events', 'Warning  Failed  pod/api-84f7c6d9b-7lq2m  Failed to pull image "registry.example.test/shop/api:v2.3.l": manifest unknown'),
      k('rollout (history|status)', 'Waiting for deployment "api" rollout to finish: 1 old replicas are pending termination...'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'The image tag v2.3.l does not exist in the registry (manifest unknown); it looks like a typo for v2.3.1', match: 'v2\\.3\\.l|typo|manifest unknown|does not exist|not found' },
        { text: 'The old pods keep serving, so users are not affected yet; fix the tag (or undo the rollout)', match: 'v2\\.3\\.1|fix the tag|correct|rollout undo|roll ?back' },
      ],
    },
  },
  {
    id: 'k8s-node-disk-pressure',
    title: 'Pods evicted, a node NotReady: disk pressure',
    tags: ['kubernetes', 'disk'],
    task: 'Pods in namespace shop are being evicted and node-3 shows NotReady. What happened?',
    targets: [cluster],
    replay: [
      k('get (nodes|no)\\b', 'NAME     STATUS     ROLES    AGE   VERSION\nnode-1   Ready      <none>   92d   v1.31.2\nnode-2   Ready      <none>   92d   v1.31.2\nnode-3   NotReady   <none>   92d   v1.31.2'),
      k('describe (node|no)\\b', 'Conditions:\n  Type             Status  Reason\n  MemoryPressure   False   KubeletHasSufficientMemory\n  DiskPressure     True    KubeletHasDiskPressure\n  Ready            False   KubeletNotReady\nEvents:\n  Warning  EvictionThresholdMet  14m  kubelet  Attempting to reclaim ephemeral-storage\n  Warning  ImageGCFailed         12m  kubelet  failed to garbage collect required amount of images. Wanted to free 21474836480 bytes, but freed 0 bytes'),
      k('get (pods|po)\\b', 'NAME                        READY   STATUS    NODE\nreport-7f9b6c5d4-x8k2l      0/1     Evicted   node-3\ncheckout-5f6b7d9c8-z9k1m    0/1     Evicted   node-3\nreport-7f9b6c5d4-m2n4p      1/1     Running   node-3'),
      k('describe (pod|po).*report', 'Containers:\n  report:\n    Image: shop/report:1.4.0\n    Mounts:\n      /tmp from scratch (rw)\nVolumes:\n  scratch:\n    Type: EmptyDir (a temporary directory that shares a pod\'s lifetime)\n    SizeLimit: <unset>\nMessage: The node was low on resource: ephemeral-storage. Container report was using 61Gi, which exceeds its request of 0.'),
      k('get events', 'Warning  Evicted  pod/report-7f9b6c5d4-x8k2l  The node was low on resource: ephemeral-storage. Container report was using 61Gi, which exceeds its request of 0.'),
    ],
    expect: {
      elements: [
        { text: 'node-3 has DiskPressure (ephemeral storage), so the kubelet marks it NotReady and evicts pods', match: 'DiskPressure|disk pressure|ephemeral' },
        { text: 'The report job fills an emptyDir scratch volume with no size limit (61Gi)', match: 'report|emptyDir|scratch' },
        { text: 'Fix: give the report job an ephemeral-storage limit or sizeLimit, and clean up node-3', match: 'limit|sizeLimit|ephemeral-storage' },
      ],
    },
  },
  {
    id: 'k8s-pending-insufficient-cpu',
    title: 'Pods stay Pending: requests larger than any node has free',
    tags: ['kubernetes', 'capacity'],
    task: 'After scaling up the worker deployment in namespace shop, the new pods stay Pending. Why?',
    targets: [cluster],
    replay: [
      k('get (pods|po)\\b', 'NAME                      READY   STATUS    AGE\nworker-6c8d9b7f5-2mk4p    0/1     Pending   18m\nworker-6c8d9b7f5-9xq3l    0/1     Pending   18m\nworker-6c8d9b7f5-t7v2n    1/1     Running   2d'),
      k('describe (pod|po)\\b', 'Containers:\n  worker:\n    Requests:\n      cpu:     6\n      memory:  2Gi\nEvents:\n  Warning  FailedScheduling  18m  default-scheduler  0/3 nodes are available: 3 Insufficient cpu. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.'),
      k('describe (node|no)\\b', 'Capacity:\n  cpu: 8\nAllocated resources:\n  Resource  Requests     Limits\n  cpu       6850m (85%)  9 (112%)'),
      k('top (nodes|no)', 'NAME     CPU(cores)   CPU%\nnode-1   1820m        22%\nnode-2   2100m        26%\nnode-3   1650m        20%'),
      k('get (deploy|deployment).*-o|get (deploy|deployment) worker', 'resources:\n  requests:\n    cpu: "6"   # was 500m before commit "tune worker" 2026-10-17'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'Each worker pod requests 6 CPUs; no node has 6 CPUs unallocated (8-CPU nodes, about 6.85 already requested), so the scheduler reports Insufficient cpu', match: 'Insufficient cpu|request|6 CPU|cpu: "?6' },
        { text: 'Actual CPU use is low (about 20-26%), so the request is far larger than needed; it was raised from 500m recently', match: '500m|over|too (high|large)|lower' },
      ],
    },
  },
  {
    id: 'k8s-readiness-probe-path',
    title: 'Rollout stuck: the readiness probe checks a path the app no longer serves',
    tags: ['kubernetes', 'deploy'],
    task: 'The inventory rollout in namespace shop has been stuck for 20 minutes. Investigate.',
    targets: [cluster],
    replay: [
      k('get (pods|po)\\b', 'NAME                          READY   STATUS    RESTARTS   AGE\ninventory-7b8c9d6f5-q2w3e     0/1     Running   0          21m\ninventory-6a5b4c3d2-z9x8c     1/1     Running   0          9d'),
      k('describe (pod|po)\\b', 'Containers:\n  inventory:\n    Image:      shop/inventory:3.0.0\n    Readiness:  http-get http://:8080/healthz delay=5s timeout=1s period=10s #success=1 #failure=3\nEvents:\n  Warning  Unhealthy  1m (x120 over 21m)  kubelet  Readiness probe failed: HTTP probe failed with statuscode: 404'),
      k('logs\\b', 'inventory 3.0.0 listening on :8080\nGET /healthz 404 0.4ms\nGET /health 200 1.1ms (from load test)\nnote: health endpoint moved to /health in 3.0.0 (see CHANGELOG)'),
      k('rollout status', 'Waiting for deployment "inventory" rollout to finish: 1 out of 2 new replicas have been updated...'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'The readiness probe checks /healthz, which inventory 3.0.0 no longer serves (404); the endpoint moved to /health', match: '/healthz|/health\\b|404' },
        { text: 'Fix: point the readiness probe at /health (or roll back); the old pods still serve traffic meanwhile', match: '/health|probe' },
      ],
    },
  },
  {
    id: 'k8s-pvc-storageclass',
    title: 'A database pod stays Pending: its volume claim names a storage class that does not exist',
    tags: ['kubernetes', 'storage'],
    task: 'The new reports-db statefulset in namespace shop never starts. Find out why.',
    targets: [cluster],
    replay: [
      k('get (pods|po)\\b', 'NAME           READY   STATUS    AGE\nreports-db-0   0/1     Pending   35m'),
      k('describe (pod|po)\\b', 'Events:\n  Warning  FailedScheduling  35m  default-scheduler  0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.'),
      k('get (pvc|persistentvolumeclaim)', 'NAME                STATUS    VOLUME   CAPACITY   STORAGECLASS   AGE\ndata-reports-db-0   Pending                         fast-ssd       35m'),
      k('describe (pvc|persistentvolumeclaim)', 'Events:\n  Warning  ProvisioningFailed  2m (x142 over 35m)  persistentvolume-controller  storageclass.storage.k8s.io "fast-ssd" not found'),
      k('get (storageclass|sc)\\b', 'NAME               PROVISIONER       RECLAIMPOLICY   VOLUMEBINDINGMODE\ngp3 (default)      ebs.csi.aws.com   Delete          WaitForFirstConsumer\nio2                ebs.csi.aws.com   Delete          WaitForFirstConsumer'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'The volume claim asks for storage class fast-ssd, which does not exist in this cluster (only gp3 and io2)', match: 'fast-ssd' },
        { text: 'Fix: use an existing class (gp3 or io2) in the volumeClaimTemplate; the claim must be recreated', match: 'gp3|io2|storage ?class' },
      ],
    },
  },
  {
    id: 'k8s-noisy-neighbour',
    title: 'Slow API on one node: a batch job without limits next to it',
    tags: ['kubernetes', 'cpu', 'misleading'],
    task: 'About a third of api requests in namespace shop are very slow, the rest are fine. Investigate.',
    targets: [cluster],
    replay: [
      k('get (pods|po).*-o wide|get (pods|po)\\b', 'NAME                   READY   STATUS    NODE\napi-5c9b8d7f6-k2m9n    1/1     Running   node-1\napi-5c9b8d7f6-p8q7r    1/1     Running   node-2\napi-5c9b8d7f6-w3e4r    1/1     Running   node-3\nbackfill-28811040-x7z  1/1     Running   node-2'),
      k('top (pods|po)', 'NAME                   CPU(cores)   MEMORY(bytes)\napi-5c9b8d7f6-k2m9n    310m         410Mi\napi-5c9b8d7f6-p8q7r    290m         402Mi\napi-5c9b8d7f6-w3e4r    305m         398Mi\nbackfill-28811040-x7z  7790m        1180Mi'),
      k('top (nodes|no)', 'NAME     CPU(cores)   CPU%\nnode-1   1420m        17%\nnode-2   7980m        99%\nnode-3   1380m        17%'),
      k('describe (pod|po).*backfill|get (pod|po) backfill.*-o', 'Containers:\n  backfill:\n    Image: shop/backfill:0.9.0\n    Requests: <none>\n    Limits:   <none>\nControlled By: Job/backfill-28811040 (CronJob backfill, schedule "0 */2 * * *")'),
      k('logs.*api', 'GET /orders 200 2140ms (node-2)\nGET /orders 200 38ms (node-1)'),
      nodes,
    ],
    expect: {
      elements: [
        { text: 'The backfill job on node-2 uses almost all of its CPU (about 7.8 of 8 cores) and has no requests or limits', match: 'backfill' },
        { text: 'The slow third of requests are the ones served by the api pod on node-2: a noisy neighbour, not an api problem', match: 'node-2|neighbou?r' },
        { text: 'Fix: give the backfill job CPU requests and limits (or keep it off the api nodes)', match: 'limit|request|affinity|taint|nodeSelector' },
      ],
    },
  },
  {
    id: 'k8s-coredns-loop',
    title: 'Every pod fails name lookups: CoreDNS detects a forwarding loop',
    tags: ['kubernetes', 'network'],
    task: 'Services in the cluster cannot resolve each other since this morning ("no such host"). Investigate.',
    targets: [cluster],
    replay: [
      k('get (pods|po).*kube-system|-n kube-system get (pods|po)', 'NAME                       READY   STATUS             RESTARTS      AGE\ncoredns-5d78c9869d-4mk2x   0/1     CrashLoopBackOff   31 (1m ago)   3h\ncoredns-5d78c9869d-9xq8w   0/1     CrashLoopBackOff   31 (2m ago)   3h'),
      k('logs.*coredns', '[FATAL] plugin/loop: Loop (127.0.0.1:45812 -> :53) detected for zone ".", see https://coredns.io/plugins/loop#troubleshooting. Query: "HINFO 4547991504243258144.3688648895315093531."'),
      k('get (configmap|cm) coredns|describe (configmap|cm) coredns', 'Corefile: |\n  .:53 {\n      errors\n      kubernetes cluster.local in-addr.arpa ip6.arpa\n      forward . /etc/resolv.conf\n      loop\n  }'),
      k('get (pods|po)\\b', 'NAME                   READY   STATUS    RESTARTS   AGE\napi-5c9b8d7f6-k2m9n    1/1     Running   0          6d'),
      k('get (nodes|no)\\b', 'NAME     STATUS   AGE   VERSION\nnode-1   Ready    3h    v1.31.2\nnode-2   Ready    3h    v1.31.2\nnode-3   Ready    3h    v1.31.2\n# nodes replaced this morning by the new node image 2026.10 (systemd-resolved stub 127.0.0.53 in /etc/resolv.conf)'),
    ],
    expect: {
      elements: [
        { text: 'CoreDNS is crash-looping because its loop plugin detects a forwarding loop', match: 'loop' },
        { text: 'It forwards to the node\'s /etc/resolv.conf, which on the new node image points at the local systemd-resolved stub, so queries come back to itself', match: 'resolv\\.conf|127\\.0\\.0\\.53|systemd-resolved|forward' },
        { text: 'Fix: forward CoreDNS to real upstream resolvers (or point kubelet --resolv-conf at /run/systemd/resolve/resolv.conf)', match: 'upstream|forward|resolv-conf|/run/systemd/resolve' },
      ],
    },
  },
];
