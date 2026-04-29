#!/usr/bin/env sh
set -eu

SCRIPT_PATH=$0
while [ -L "$SCRIPT_PATH" ]; do
  LINK_TARGET=$(readlink "$SCRIPT_PATH")
  case "$LINK_TARGET" in
    /*) SCRIPT_PATH=$LINK_TARGET ;;
    *) SCRIPT_PATH=$(dirname -- "$SCRIPT_PATH")/$LINK_TARGET ;;
  esac
done

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
IMAGE_NAME="exposure-exposure:latest"
IMAGE_TAR="/tmp/exposure-exposure.tar"
NAMESPACE="exposure"
DEPLOYMENT_NAME="exposure"
MANIFEST_PATH="$REPO_DIR/k8s/exposure.yaml"

echo "[1/6] Building Docker image..."
docker build -t "$IMAGE_NAME" "$REPO_DIR"

echo "[2/6] Exporting Docker image..."
docker save "$IMAGE_NAME" -o "$IMAGE_TAR"

echo "[3/6] Importing image into k3s container runtime..."
k3s ctr images import "$IMAGE_TAR"

if [ -f "$MANIFEST_PATH" ]; then
  echo "[4/6] Applying Kubernetes manifest..."
  k3s kubectl apply -f "$MANIFEST_PATH"
else
  echo "[4/6] Skipping manifest apply because $MANIFEST_PATH was not found."
fi

echo "[5/6] Restarting deployment..."
k3s kubectl rollout restart deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE"

echo "[6/6] Waiting for rollout to complete..."
k3s kubectl rollout status deployment/"$DEPLOYMENT_NAME" -n "$NAMESPACE"

echo
echo "Deployment complete. Current pod status:"
k3s kubectl get pods -n "$NAMESPACE"

echo
echo "Public endpoint check:"
curl -I https://exposure.timurjamestanurhan.com