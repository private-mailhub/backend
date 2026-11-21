# Guard the contract between the independently deployed worker and consumer stacks.
require 'yaml'

root = File.expand_path('../../infra/worker', __dir__)
worker = YAML.safe_load(File.read(File.join(root, 'template.yaml'))).fetch('Resources').fetch('Worker')
mapping = YAML.safe_load(File.read(File.join(root, 'mapping.yaml'))).fetch('Resources').fetch('QueueMapping')
reserved = worker.fetch('Properties').fetch('ReservedConcurrentExecutions')
queue_max = mapping.fetch('Properties').fetch('ScalingConfig').fetch('MaximumConcurrency')
abort 'Expected explicit integer concurrency limits in both templates' unless [reserved, queue_max].all? { |n| n.is_a?(Integer) && n.positive? }
# The pre- and post-traffic hooks invoke the candidate sequentially; only one probe slot is needed.
abort "Worker reservation #{reserved} must cover #{queue_max} SQS invocations plus a deployment probe" unless reserved >= queue_max + 1
puts "Worker reservation #{reserved}: up to #{queue_max} SQS invocations, at least one slot for a deployment probe"
