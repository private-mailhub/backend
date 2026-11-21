#!/usr/bin/env ruby
# frozen_string_literal: true
require 'yaml'

root = File.expand_path('..', __dir__)
required = { 'ci.yml' => 'backend-quality', 'worker-ci.yml' => 'mail-worker-offline' }
check_names = []

required.each do |file, expected|
  flow = YAML.safe_load(File.read(File.join(root, '.github', 'workflows', file)))
  # YAML 1.1 (system Ruby/Psych) may decode the unquoted key 'on' as true.
  events = flow.fetch('on') { flow.fetch(true) }
  %w[pull_request push].each do |event|
    filters = events.fetch(event) || {}
    abort "#{file}: #{event} must allow PRs/pushes to main without path filters" unless
      filters.is_a?(Hash) && (filters.keys & %w[paths paths-ignore branches-ignore]).empty? &&
      (!filters.key?('branches') || filters['branches'] == ['main'])
    if event == 'pull_request' && filters.key?('types')
      abort "#{file}: missing normal PR updates" unless (%w[opened reopened synchronize] - Array(filters['types'])).empty?
    elsif event == 'push'
      abort "#{file}: push must include branches, not only tags" if !filters.key?('branches') && (filters.keys & %w[tags tags-ignore]).any?
    end
  end

  jobs = flow.fetch('jobs')
  check = jobs.fetch('verify')
  abort "#{file}: expected an unconditional #{expected} check" unless check['name'] == expected && !check.key?('if')
  check_names.concat(jobs.map { |id, job| job.fetch('name', id) })
end

required.each_value do |name|
  abort "duplicate or missing required context: #{name}" unless check_names.count(name) == 1
end
puts 'CI required contexts: backend-quality and mail-worker-offline'
