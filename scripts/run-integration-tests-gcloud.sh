#!/usr/bin/env bash

# TODO: this script currently uses goerli as the RPC provider. However, it
# should be extended to use its own instance of hardhat too.

# prevent souring of this script, only allow execution
$(return >/dev/null 2>&1)
test "$?" -eq "0" && { echo "This script should only be executed." >&2; exit 1; }

# exit on errors, undefined variables, ensure errors in pipes are not hidden
set -Eeuo pipefail

# set log id and use shared log function for readable logs
declare mydir
mydir=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd -P)
declare -x HOPR_LOG_ID="e2e-gcloud-test"
source "${mydir}/utils.sh"
source "${mydir}/gcloud.sh"
source "${mydir}/testnet.sh"

usage() {
  msg
  msg "Usage: $0 [<test_id> [<docker_image>]]"
  msg
  msg "where <test_id>:\tuses a random value as default"
  msg "      <docker_image>:\tuses 'gcr.io/hoprassociation/hoprd:latest' as default"
  msg
  msg "Supported environment variables"
  msg "-------------------------------"
  msg
  msg "HOPRD_SKIP_CLEANUP\t\tSet to 'true' to skip the cleanup process and keep resources running."
  msg "HOPRD_SHOW_PRESTART_INFO\tSet to 'true' to print used parameter values before starting."
  msg "HOPRD_RUN_CLEANUP_ONLY\t\tSet to 'true' to execute the cleanup process only."
  msg
}

# return early with help info when requested
{ [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; } && { usage; exit 0; }

# verify and set parameters
declare test_id="e2e-gcloud-test-${1:-$RANDOM-$RANDOM}"
declare docker_image=${2:-gcr.io/hoprassociation/hoprd:latest}

declare api_token="e2e-API-token^^"
declare password="pw${RANDOM}${RANDOM}${RANDOM}pw"
declare rpc_endpoint="https://goerli.infura.io/v3/${HOPRD_INFURA_KEY}"
declare hopr_token_contract="0x566a5c774bb8ABE1A88B4f187e24d4cD55C207A5"
declare skip_cleanup="${HOPRD_SKIP_CLEANUP:-false}"
declare show_prestartinfo="${HOPRD_SHOW_PRESTART_INFO:-false}"
declare run_cleanup_only="${HOPRD_RUN_CLEANUP_ONLY:-false}"

function cleanup {
  local EXIT_CODE=$?

  trap - SIGINT SIGTERM ERR EXIT
  set +Eeuo pipefail

  # Cleaning up everything
  gcloud_delete_managed_instance_group "${test_id}"
  gcloud_delete_instance_template "${test_id}"

  exit $EXIT_CODE
}

function fund_ip() {
  local ip="${1}"
  local eth_address

  wait_until_node_is_ready "${ip}"
  eth_address=$(get_eth_address "${ip}")
  fund_if_empty "${eth_address}" "${rpc_endpoint}" "${hopr_token_contract}"
  wait_for_port "9091" "${ip}"
}

if [ "${run_cleanup_only}" = "1" ] || [ "${run_cleanup_only}" = "true" ]; then
  cleanup

  # exit right away
  exit
fi

if [ "${skip_cleanup}" != "1" ] && [ "${skip_cleanup}" != "true" ]; then
  trap cleanup SIGINT SIGTERM ERR EXIT
fi

# --- Log test info {{{
if [ "${show_prestartinfo}" = "1" ] || [ "${show_prestartinfo}" = "true" ]; then
  log "Pre-Start Info"
  log "\tdocker_image: ${docker_image}"
  log "\ttest_id: ${test_id}"
  log "\tapi_token: ${api_token}"
  log "\tpassword: ${password}"
  log "\trpc_endpoint: ${rpc_endpoint}"
  log "\thopr_token_contract: ${hopr_token_contract}"
  log "\tskip_cleanup: ${skip_cleanup}"
fi
# }}}

# create test specific instance template
gcloud_create_or_update_instance_template "${test_id}" \
  "${docker_image}" \
  "${rpc_endpoint}" \
  "${api_token}" \
  "${password}"
#
# start nodes
gcloud_create_or_update_managed_instance_group "${test_id}" \
  6 \
  "${test_id}"

# get IPs of newly started VMs which run hoprd
declare node_ips
node_ips=$(gcloud_get_managed_instance_group_instances_ips "${test_id}")
declare node_ips_arr=( ${node_ips} )

#  --- Fund nodes --- {{{
declare eth_address
for ip in ${node_ips}; do
  wait_until_node_is_ready "${ip}"
  eth_address=$(get_eth_address "${ip}")
  fund_if_empty "${eth_address}" "${rpc_endpoint}" "${hopr_token_contract}"
done

for ip in ${node_ips}; do
  wait_for_port "9091" "${ip}"
done
# }}}

# --- Run security tests --- {{{
"${mydir}/../test/security-test.sh" \
  "${node_ips_arr[0]}" 3001 3000
#}}}

# --- Run test --- {{{
"${mydir}/../test/integration-test.sh" \
  ${node_ips_arr[@]/%/:3001}
# }}}
